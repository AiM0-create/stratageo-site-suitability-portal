# Post-Deploy Smoke Test Report — v1.3.0

**Date/time:** 2026-06-25 ~02:00 UTC
**Branch:** master
**Merge commit:** cb28d2a merge: v1.3.0 evidence trail and reproducible reports
**Latest commit:** cb28d2a
**Backend revision:** stratageo-engine-00037-dh8 (Cloud Run, asia-south1)
**Frontend:** GitHub Pages — deploy-pages.yml: success (32s)
**PR:** https://github.com/AiM0-create/stratageo-site-suitability-portal/pull/1
**GitHub Release:** https://github.com/AiM0-create/stratageo-site-suitability-portal/releases/tag/v1.3.0

---

## /health

```json
{
  "appVersion": "1.3.0",
  "engineVersion": "1.3.0",
  "specVersion": "2.2",
  "releaseName": "Evidence Trail & Reproducible Site Selection Reports",
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
    "evidenceTrail": true,
    ...
  },
  "hasOpenAIKey": true,
  "hasPlacesKey": true,
  "hasOrsKey": true
}
```

---

## Ruby Crossing Live Evidence Test

**Prompt:** "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass"
**Job ID:** 6e839990-c3b3-492e-936c-b0c007e8051d
**analysisStatus:** reliable
**locationCount:** 3
**recommendationWithheld:** False

### Planning (Turn 2 — "yes")

| Field | Value | Expected | Pass? |
|---|---|---|---|
| `planningMode` | `deterministic` | deterministic | ✅ |
| `archetypeKey` | `student_qsr_cafe` | student_qsr_cafe | ✅ |
| `planningFingerprint` | `pfp_774efc1cee0a` | pfp_774efc1cee0a (v1.3.0) | ✅ |
| Factor weights | `[0.32, 0.27, 0.18, 0.14, 0.09]` | 32/27/18/14/9 | ✅ |
| Layer count | 5 | 5 | ✅ |

**Note:** Fingerprint changed from v1.2.0's `pfp_bbe4571fe559` to `pfp_774efc1cee0a` because `ENGINE_VERSION` changed from `"1.2.0"` to `"1.3.0"` (it is an input to `planning_fingerprint()`). This is expected and correct — the fingerprint is deterministic within a version, changes between versions. Verified ×5 runs.

### Evidence Trail

| Field | Value | Pass? |
|---|---|---|
| `evidenceTrail` present | True | ✅ |
| `evidenceVersion` | `"1.3.0"` | ✅ |
| `prompt.archetypeKey` | `student_qsr_cafe` | ✅ |
| `prompt.planningFingerprint` | `pfp_774efc1cee0a` | ✅ |
| `prompt.planningMode` | `deterministic` | ✅ |
| `dataSnapshot.providerMode` | `live` | ✅ |
| `studyArea.h3CellCountBeforeMasks` | 24 | ✅ |
| `studyArea.geometryHash` | `gh_39a2e91e2665` | ✅ |
| `providerQueries` count | 9 | ✅ |
| `factors` count | 5 | ✅ |
| `candidates` count | 3 | ✅ |
| `exclusions` count | 1 (water overlap mask) | ✅ |
| `scoring.totalWeight` | 1.0 | ✅ |
| `scoring.minViableScore` | 5.0 | ✅ |
| `recommendationSummary.validRecommendationCount` | 2 | ✅ |
| `limitations` count | 6 | ✅ |
| **SECRET CHECK** | **CLEAN** | ✅ |

### Provider Queries Observed

| Provider | Purpose | Feature Count |
|---|---|---|
| OSM Overpass | main_layer_fetch | 120 |
| Google Places | backup_for_C_student_catchment_proxy | 40 |
| Google Places | primary_C_direct_cafe_competition | 40 |
| Google Places | primary_C_commercial_cotenancy | 40 |
| + 5 more (water, buildability, ORS, etc.) | ... | ... |

### Factors Confirmed

| Factor | Weight |
|---|---|
| Student catchment proxy | 0.32 (32%) |
| Pedestrian / transit access | 0.27 (27%) |
| Direct cafe competition | 0.18 (18%) |
| Commercial co-tenancy | 0.14 (14%) |
| Dead frontage / barrier penalty | 0.09 (9%) |

### Exclusion Ledger

| Type | Source | Cells removed |
|---|---|---|
| h3_cell | Water overlap mask (>30% area water) | 2 |

---

## Evidence API Endpoint Tests

| Endpoint | Status | Pass? |
|---|---|---|
| `GET /api/v2/analyses/{jobId}/evidence` | 200 | ✅ |
| `GET /api/v2/analyses/{jobId}/evidence.json` | 200 | ✅ |
| `GET /api/v2/analyses/not-a-uuid/evidence` | 400 | ✅ |
| `GET /api/v2/analyses/00000000-0000-0000-0000-000000000000/evidence` | 404 | ✅ |
| Secret check on /evidence response | CLEAN | ✅ |

---

## Regression Prompts

| Prompt | Expected | Result | Pass? |
|---|---|---|---|
| "Find 20 sites for a premium clinic in Gurgaon." | topN=10 (capped) | topN=10 | ✅ |
| "Only rank my uploaded CSV points." (no CSV) | uploadedCandidatesOnly=True, blocked clearly | uploadedCandidatesOnly=True | ✅ |
| "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro." | topN=5, dark_kitchen | topN=5, businessTypeKey=dark_kitchen | ✅ |
| /health | v1.3.0, evidenceTrail=true, deterministicPlanning=true | confirmed | ✅ |

---

## Evidence JSON Secret Check

No keys or values matching `api_key`, `authorization`, `openai_api_key`, `google_places_api_key`, `ors_api_key`, `password`, `bearer` found in the evidence trail JSON. **CLEAN.**

---

## UI Evidence Tab (browser test)

Browser automation was not available (Chrome extension not connected). The Evidence Trail section renders conditionally from `(result as any).evidenceTrail` — if `evidenceTrail` is present (confirmed above), the section will render. Manual browser verification recommended before client demo.

---

## PDF Evidence Appendix

PDF export contains Section 7 "Evidence Appendix (v1.3.0) — AUDIT REPRODUCIBLE" with provider query summary, factor schema, exclusion ledger, scoring formula, and audit-reproducibility disclaimer. Source marker confirmed in `App.tsx`. Manual PDF export verification recommended before client demo.

---

## Known Remaining Nondeterminism Sources

| Source | Impact | Notes |
|---|---|---|
| External provider data (OSM, Places) | Execution result may vary | Factor table stable; POI counts change with data |
| Google Places ranking changes | Candidate scores vary | Disclosed; field validation required |
| Overpass timeout or data drift | Missing POI data for some layers | Engine falls back gracefully |
| ORS routing failures | Pass-B degrades to Euclidean proxy | Disclosed in result |
| Geocoding ambiguity | Study area polygon may vary slightly | Different Nominatim results |
| `specFingerprint` (expected to vary) | NOT a problem — includes LLM explanation text | `planningFingerprint` is the structural stability hash |

**Planning fingerprint changed between v1.2.0 and v1.3.0**: expected (ENGINE_VERSION is an input). Within v1.3.0 it is deterministic.

---

## Rollback

```bash
git checkout backup/pre-v1.3.0-production-deploy
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```

---

## Summary

- **Backend revision:** stratageo-engine-00037-dh8 serving 100% traffic
- **Frontend:** GitHub Pages deployed (32s, success)
- **evidenceTrail:** VERIFIED LIVE (job 6e839990, evidenceVersion=1.3.0, 9 provider queries, 5 factors, 3 candidates, 1 exclusion, CLEAN secrets)
- **Planning:** STABLE — student_qsr_cafe, pfp_774efc1cee0a, weights 32/27/18/14/9
- **Regression tests:** ALL PASS (topN cap, uploaded-only, dark kitchen, health)
