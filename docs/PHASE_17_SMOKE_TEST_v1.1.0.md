# Phase 17 Smoke Test & Hard-Constraint Enforcement Audit — v1.1.0

**Audit date:** 2026-06-24
**Branch:** `feature/v1.1.0-universal-suitability-logic`
**Commit (post-Phase 17 fixes):** see git log
**Backup tag:** `backup/pre-v1.1.0-universal-suitability`

---

## Note on smoke-testing methodology

The deterministic layer (RawIntent parser, archetype registry, multi-score engine,
config) was tested with live Python assertions. Full LLM end-to-end testing (what
the gpt-4o consultant actually builds for each prompt) requires a live API call
and cannot be automated in offline CI. The results below are from the deterministic
parser output; the SpecV2 and recommendation columns reflect what the engine
**should** produce assuming the LLM follows its system prompt correctly.

---

## 1. Smoke Prompt Results

### P1 — "Find 3 best locations for a premium cafe in Indiranagar."

| Field | Value |
|---|---|
| topNResolved | 3 (explicit "3 best" parsed) |
| businessTypeKey | cafe → qsr_restaurant archetype |
| Hard constraints detected | 0 (no spatial hard constraint in prompt) |
| Expected SpecV2 representation | studyArea.places = ["Indiranagar"] |
| Recommendation mode | recommended_sites |
| Site claim level | micro_market_zone |
| Critic enabled (low mode) | **NO** — critic disabled in low cost mode |
| Output wording honest? | Yes — no "best site" claim; candidate zone |
| Risk | None. Clean prompt. |

### P2 — "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro."

| Field | Value |
|---|---|
| topNResolved | **5** ✅ (correctly parsed after Phase 16 fix) |
| businessTypeKey | dark_kitchen |
| Hard constraints detected | 1 phrase: "outside 1 km of any metro" |
| Spatial relations | outside_distance, near_anchor, avoid_anchor |
| Expected SpecV2 representation | exclusions: [{name: "metro", bufferM: 1000}] |
| Critic enabled | NO (low mode) |
| Enforcement | Depends on LLM creating the exclusion entry ⚠️ |
| Risk | Medium — "outside 1 km of metro" must be expressed as spec.exclusions; if LLM omits it, constraint is not enforced. No blocking gate in v1.1.0. |

### P3 — "Find 20 sites for a premium clinic in Gurgaon."

| Field | Value |
|---|---|
| topNResolved | **10** (capped from 20) ✅ |
| requestedTopNRaw | 20 |
| outputCountWarning | "Capped at 10 outputs..." ✅ |
| businessTypeKey | clinic |
| Hard constraints | 0 (no spatial constraint; "20 sites" is an output count) |
| Risk | None. Cap warning shown. |

### P4 — "Find one warehouse near NH44 but away from dense residential areas."

| Field | Value |
|---|---|
| topNResolved | **1** ✅ |
| businessTypeKey | warehouse |
| Hard constraints detected | 1: "away from dense residential areas" |
| Expected SpecV2 | exclusions or negative scoring layer for residential density |
| Enforcement | Depends on LLM — exclusion buffer for residential is advisory in v1.1.0 ⚠️ |
| Risk | Medium — "away from residential" is not deterministically enforced. Will rely on LLM creating spec.exclusions. |

### P5 — "Find a resort location in a scenic low-density area near Dehradun."

| Field | Value |
|---|---|
| topNResolved | 3 (default — no explicit count) |
| businessTypeKey | resort → hotel archetype |
| Hard constraints | 0 (scenic/low-density are soft preferences, not hard gates) |
| Risk | Low. No hard constraint. Archetype correctly identified. |

### P6 — "Only rank my uploaded CSV points."

| Field | Value |
|---|---|
| topNResolved | 3 (default) |
| hasUploadedCandidates | **true** ✅ |
| Hard constraints detected | 1: "Only rank my uploaded CSV points" |
| SpecV2 enforcement | ❌ **NOT ENFORCED** — engine scores all hexes in study area; CSV points are not restricted to |
| Advisory warning | Added to result notes: "uploaded CSV points only mode is NOT yet enforced by the engine" |
| Risk | **HIGH gap** — user expects only their points to be ranked; engine ignores this. Results are misleading unless the warning is clearly visible. Must be addressed in v1.2 before promoting as production feature. |

### P7 — "Find a site within 500 m of a metro station but outside 2 km of any metro station."

| Field | Value |
|---|---|
| topNResolved | 3 (default) |
| Hard constraints | 1 phrase detected |
| Spatial relations | within_distance, outside_distance |
| Contradictory constraint detection | **Detected** ✅ (500 m ≤ 2000 m → logically impossible) |
| What LLM should do | Return feasibility.status = "not_feasible" with conflict explanation |
| What engine does | Passes to LLM. If LLM correctly identifies the contradiction, spec.feasibility blocks readyToExecute. If LLM misses it, both constraints may be encoded and produce an empty result. |
| Risk | Medium — contradiction detection is now in the parser. The LLM's feasibility gate should block this. The engine returns empty results if both constraints leave no valid hexes. Result is honest. |

### P8 — "Find a riverside restaurant strictly between Howrah Bridge and Vidyasagar Setu."

| Field | Value |
|---|---|
| topNResolved | 3 (default) |
| businessTypeKey | restaurant |
| Spatial relations | between_landmarks |
| betweenLandmarks detected | ["Howrah Bridge", "Vidyasagar Setu"] ✅ |
| Hard constraints | "strictly between Howrah Bridge" ✅ |
| SpecV2 enforcement | studyArea.places (convex hull of landmarks) + waterfront corridor (v1.0.3 deterministic) |
| Critic enabled | NO (low mode) |
| Risk | Low — this is the well-tested v1.0.3 case. Waterfront corridor and buildability masks are deterministically enforced regardless of LLM quality. Most likely result: insufficient_viable_land (correct behaviour). |

---

## 2. Hard-Constraint Enforcement Matrix

| Constraint type | Parsed? | Stored in spec? | Enforced? | Blocks? | Downgrades? | UI shown? |
|---|---|---|---|---|---|---|
| **within_distance** (within X m of Y) | ✅ intent_parser | Requires LLM → routeConstraints | Depends on LLM | Only if LLM sets required=True | Yes (missed data) | Yes (routeMetrics) |
| **outside_distance** (outside X m of Y) | ✅ intent_parser | Requires LLM → exclusions | Depends on LLM | Only if LLM creates exclusion | Advisory warning if missing | Yes (exclusions) |
| **between_landmarks** | ✅ intent_parser + geography | studyArea.places → polygon | ✅ DETERMINISTIC | ✅ Yes (hexes outside polygon never scored) | — | Yes (studyAreaBoundary on map) |
| **along_linear_feature** (waterfront) | ✅ intent_parser + spec.py | corridors (auto-injected by v1.0.3) | ✅ DETERMINISTIC | ✅ Yes (waterfront corridor mask) | insufficient_viable_land | Yes (mask stats, corridor notes) |
| **avoid_feature** (away from railway/water) | ✅ intent_parser | Requires LLM → exclusions | Depends on LLM | Only if LLM creates exclusion | Advisory warning if missing | Yes (exclusions) |
| **uploaded_points_only** | ✅ intent_parser (hasUploadedCandidates) | ❌ NOT in SpecV2 at all | ❌ NOT ENFORCED | ❌ No | Advisory note added | Advisory note only |
| **route/time constraint** (within N min walk) | ✅ intent_parser (within_walk_time) | Requires LLM → routeConstraints | ✅ if ORS available | ✅ if required=True | Yes (route unavailable → excluded) | Yes (routeMetrics) |
| **no-build/protected/water** | ✅ buildability/water masks | n/a (deterministic) | ✅ DETERMINISTIC | ✅ Yes (hexes masked out) | insufficient_viable_land | Yes (mask stats) |
| **contradictory constraints** | ✅ detect_contradictory_constraints() | LLM → feasibility.not_feasible | Partial (LLM gate) | Only if LLM detects it | Advisory note from parser | Feasibility block |
| **validate gate (advisory)** | ✅ validate_hard_constraints_in_spec() | Advisory warning in notes | ❌ Not blocking | ❌ Advisory only | Advisory note in result | Notes field |

### Summary

**Deterministically enforced (v1.1.0):**
- Between landmarks (study area polygon)
- Waterfront / along-feature (v1.0.3 corridor + water + buildability masks)
- No-build / protected land / water body

**Enforced only if LLM builds the SpecV2 correctly:**
- within_distance → routeConstraints
- outside_distance → exclusions
- avoid_feature → exclusions
- route/time constraint → routeConstraints (+ ORS availability)
- contradictory constraints → feasibility.not_feasible

**Not enforced in v1.1.0 (scoped to v1.2):**
- "uploaded points only" mode

---

## 3. Constraint Enforcement Level Disclosure

Added to every result JSON (Phase 17):
```json
{
  "criticEnabled": false,
  "constraintEnforcementLevel": "advisory",
  "untracedConstraints": ["...any untraced hard constraint phrases..."]
}
```

Shown in ResultsDrawer:
- "Reliability critic: **Disabled (low cost mode)**" (amber)
- "Constraint enforcement: **Advisory (v1.1.0 — hard gates in v1.2)**" (amber)
- Red warning if `untracedConstraints.length > 0`

---

## 4. Critic Enabled/Disabled Disclosure

| Layer | Status |
|---|---|
| `config.py` | `critic_active` property: False when cost_mode="low" ✅ |
| `jobs.py` | `criticEnabled: bool(critique is not None)` in result JSON ✅ |
| ResultsDrawer | "Reliability critic: Enabled/Disabled" pill ✅ |
| `/health` | `costMode: "low"`, `criticEnabled: false` ✅ |
| PDF | Version metadata section includes cost mode note ✅ |

---

## 5. Phase 17 Bugs Found and Fixed

| # | Bug | Severity | Fix |
|---|---|---|---|
| 1 | Contradictory constraint regex failed to flag "within 500m AND outside 2km" — units (m vs km) not normalized before comparison | Medium | Rewrote `detect_contradictory_constraints()` to normalize to metres via `_to_metres()` |
| 2 | SyntaxWarning in `detect_contradictory_constraints` regex f-string | Low | Changed to raw string `r"outside\|beyond\|..."` |
| 3 | `validate_hard_constraints_in_spec` imported in jobs.py but never called | Medium | Wired as advisory check in `_run_analysis()` preamble; results added to `notes[]` and `untracedConstraints` in result JSON |
| 4 | No critic enabled/disabled disclosure in result JSON or UI | Medium | Added `criticEnabled`, `constraintEnforcementLevel`, `untracedConstraints` to result JSON and ResultsDrawer display |
| 5 | "Uploaded points only" mode detected but not disclosed as unenforced | Medium | Added explicit advisory note in `_run_analysis()` when `hasUploadedCandidates=True` |

---

## 6. Test Results

```
Backend: 215 passed / 0 failed (17 new tests in test_phase17_smoke.py)
Frontend TypeScript: CLEAN (no errors)
Frontend Build: SUCCESS (9.31s, 1002 modules)
```

---

## 7. Unresolved Risks for v1.2

| Risk | Severity | v1.2 action |
|---|---|---|
| "Uploaded points only" mode not enforced | HIGH | Implement candidate-restriction mode in engine |
| Hard constraint gate is advisory — depends on LLM | MEDIUM | Wire `validate_hard_constraints_in_spec` as a blocking gate in analyses router |
| Critic disabled by default (low mode) | MEDIUM | Document clearly; operators should set BALANCED for production quality |
| Contradictory constraint detection is heuristic only | LOW | Improve with semantic reasoning in v1.2 |
| Dead `resultCount`/`onResultCountChange` props in FloatingAssistant | LOW | Remove in cleanup PR |

---

## 8. Language and Honesty Check

| Check | Result |
|---|---|
| "best site" / "final site" in UI | ❌ Not found in any component ✅ |
| "parcel site" overclaim | ❌ Not found ✅ |
| Critic validation implied when disabled | ❌ Now disclosed explicitly ✅ |
| Constraint enforcement implied as strong | ❌ "advisory" label visible in UI ✅ |
| "uploaded points only" implied as enforced | ❌ Advisory warning added ✅ |
| PDF disclaimer present | ✅ "Screening-level assessment, not legal/parcel/field due diligence" |

---

## 9. Rollback Command

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# Redeploy backend and rebuild frontend
```

---

## FINAL RECOMMENDATION

# ⚠️ SAFE TO MERGE TO STAGING ONLY

**Do NOT merge directly to main/production yet.**

### Why not main:

1. **"Uploaded points only" (P6) is NOT enforced.** The engine ignores this constraint and scores all hexes. A user who uploads 5 candidate sites and says "Only rank my uploaded points" will receive results from the full study area, not their 5 points. This is a **functional gap that violates user intent** for this specific prompt type. The advisory warning is honest, but the feature should be either blocked (refuse the prompt with a clear message) or enforced before going to production.

2. **Hard constraints are advisory-only for constraint types that depend on LLM SpecV2 quality** (within_distance → routeConstraints, outside_distance → exclusions). The deterministic layer cannot yet verify that every hard constraint in the raw prompt was actually enforced. This is acceptable for a **suitability screening tool** (not a compliance system), but should be clearly stated in the UI.

3. **Critic is disabled by default** (low cost mode). Production quality requires operators to explicitly enable it by setting `STRATAGEO_MAX_LLM_COST_MODE=balanced` before going live.

### What staging will validate:
- That gpt-4o correctly builds SpecV2 gates for the hard constraints the parser detects
- That the multi-score outputs (R/V/C) look reasonable on real analyses
- That the archetype registry produces better factor selection across prompt types
- That the output count, cap, and warning flow work end-to-end

### Before merging to main, complete:
1. Either enforce or block "uploaded points only" mode (v1.2 item)
2. Set `STRATAGEO_MAX_LLM_COST_MODE=balanced` in Secret Manager for production quality
3. Run the 8 smoke prompts on the staging environment and confirm:
   - P2: "outside 1 km of metro" appears in spec.exclusions
   - P6: advisory note is clearly visible
   - P7: feasibility.not_feasible correctly returned (or both constraints produce empty results honestly)
   - P8: insufficient_viable_land returned with correct grey markers
