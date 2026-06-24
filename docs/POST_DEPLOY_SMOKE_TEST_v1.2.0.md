# Post-Deploy Smoke Test Report — v1.2.0

**Date/time:** 2026-06-24 ~18:00 UTC
**Branch:** master
**Latest commit:** edc8b8e fix: read incoming spec rawIntent for deterministic planner in multi-turn
**Merge commit:** fba755e merge: v1.2.0 deterministic planning upgrade
**Backend revision:** stratageo-engine-00036-rv5 (Cloud Run, asia-south1)
**Frontend:** GitHub Pages — deploy-pages.yml: success (30 s)

---

## Bugs found and fixed during live deployment

### Bug: multi-turn rawIntent resolution (2 fix iterations)

**Symptom:** In a two-turn session (turn 1 = full prompt, turn 2 = "yes"), the deterministic
planner was resolving `archetypeKey=generic` instead of `student_qsr_cafe`.

**Root cause (found during live test):** `last_user` in turn 2 is "yes". Two successive fixes were required:

**Fix 1 (9445913) — wrong:** Read `stored_ri` from `new_spec.get("rawIntent")`. But `new_spec` had already been overwritten by `setdefault("rawIntent", raw_intent.to_dict())` using the "yes" rawIntent — so the read returned the wrong business type.

**Fix 2 (edc8b8e) — correct:** Read rawIntent from the INCOMING `spec` parameter (the spec the client sent from turn 1), NOT from `new_spec`. The turn 1 response correctly stores `rawIntent` with the original prompt's `businessTypeKey="qsr_restaurant"` and full `rawPrompt`, which allows `resolve_canonical_archetype("qsr_restaurant", ORIGINAL_PROMPT)` → `student_qsr_cafe`.

---

## /health

```json
{
  "appVersion": "1.2.0",
  "engineVersion": "1.2.0",
  "specVersion": "2.2",
  "releaseName": "Deterministic Planning & Constraint Enforcement Upgrade",
  "modelConfig": {
    "chatModel": "gpt-5.4-mini",
    "reasoningModel": "gpt-5.4-mini",
    "criticModel": "gpt-5.4",
    "reportModel": "gpt-5.4-nano",
    "fastModel": "gpt-5.4-nano"
  },
  "costMode": "low",
  "featureFlags": {
    "deterministicPlanning": true,
    ...
  }
}
```

---

## Ruby Crossing prompt — 2-session live determinism test

| Field | Session 1 | Session 2 | Stable? |
|---|---|---|---|
| `planningMode` | deterministic | deterministic | STABLE |
| `archetypeKey` | student_qsr_cafe | student_qsr_cafe | STABLE |
| `planningFingerprint` | pfp_bbe4571fe559 | pfp_bbe4571fe559 | STABLE |
| `weightsSource` | deterministic_registry | deterministic_registry | STABLE |
| `llmRole` | explanation_only | explanation_only | STABLE |
| `recommendationMode` | candidate_zones | candidate_zones | STABLE |
| `siteClaimLevel` | micro_market_zone | micro_market_zone | STABLE |
| `topN` | 3 | 3 | STABLE |
| Factor keys | [student_catchment_proxy, pedestrian_transit_access, direct_cafe_competition, commercial_cotenancy, frontage_barrier_penalty] | same | STABLE |
| Factor weights | {32, 27, 18, 14, 9} | {32, 27, 18, 14, 9} | STABLE |

**Result: ALL STABLE — live determinism verified**

---

## Regression tests

| Prompt | Expected | Result |
|---|---|---|
| "Find 20 sites for a premium clinic in Gurgaon." | topN=10 (capped), clinic archetype | topN=10, biz=clinic, HTTP 200 |
| "Only rank my uploaded CSV points." (no CSV) | blocked clearly | HTTP 200, no H3 fallback |
| "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro." | topN=5, dark_kitchen | topN=5, biz=dark_kitchen, HTTP 200 |
| /health | v1.2.0, deterministicPlanning=true | confirmed |

---

## Known remaining nondeterminism sources

| Source | Impact | Notes |
|---|---|---|
| External provider data updates (OSM, Places) | Execution result may vary | Factor table is stable; POI counts change with data |
| Google Places ranking changes | Candidate scores vary | Disclosed; field validation required |
| Overpass timeout or data drift | Missing POI data for some layers | Engine falls back gracefully; noted in result |
| ORS routing failures | Pass B isochrones degrade to Euclidean proxy | Disclosed in result |
| Geocoding ambiguity ("Ruby Crossing") | Study area polygon may vary slightly | Different Nominatim/Google results for the same place name |
| `specFingerprint` (expected to vary) | NOT a problem — it includes LLM explanation text | `planningFingerprint` is the structural stability hash |

---

## Safe for demo?

YES — factor table and weights are stable. The Ruby Crossing prompt consistently resolves to `student_qsr_cafe` with weights 32/27/18/14/9 across all sessions.

## Safe for client recommendations?

CONDITIONAL — the planning phase is deterministic. Execution results depend on live spatial data (OSM, Places) which may vary by fetch time. Field validation is always required before acting on any recommendation.

---

## Rollback

```bash
git checkout backup/pre-v1.2.0-production-deploy
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```
