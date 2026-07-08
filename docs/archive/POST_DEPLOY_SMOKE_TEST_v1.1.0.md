# Post-Deploy Smoke Test Report — v1.1.0

**Date/time:** 2026-06-24 05:21 UTC
**Branch:** master
**Latest commit:** 61428ec (docs update) / 9b105dd (Phase 18 feature)
**Backend revision:** stratageo-engine-00027-q9c (Cloud Run, asia-south1)
**Frontend:** GitHub Pages — deployed via `deploy-pages.yml` workflow, status: success

---

## Backend Health Result

```json
{
  "ok": true,
  "appVersion": "1.1.0",
  "apiVersion": "v2",
  "engineVersion": "1.1.0",
  "specVersion": "2.1",
  "releaseName": "Universal Suitability Logic Upgrade",
  "modelConfig": {
    "chatModel": "gpt-4o",
    "reasoningModel": "gpt-4o",
    "criticModel": "gpt-4o",
    "reportModel": "gpt-4o-mini",
    "fastModel": "gpt-4o-mini",
    "escalationModel": null,
    "escalationEnabled": false
  },
  "costMode": "low",
  "featureFlags": {
    "rawIntentParser": true,
    "universalArchetypes": true,
    "multiScoreOutput": true,
    "universalCritic": true,
    "modelEscalation": false
  },
  "sandbox": false,
  "criticEnabled": false,
  "hasOpenAIKey": true,
  "hasPlacesKey": true,
  "hasOrsKey": true
}
```

**Health check:** `appVersion: 1.1.0` ✅ · `engineVersion: 1.1.0` ✅ · `costMode: low` ✅ · critic disabled (correct for `low` mode) ✅ · all feature flags enabled ✅ · all API keys present ✅

---

## Production Cost Mode

`STRATAGEO_MAX_LLM_COST_MODE=low`

Critic is **disabled** in `low` mode (default, cost-sensitive). For client-grade reports with post-execution review: set `STRATAGEO_MAX_LLM_COST_MODE=balanced` in Secret Manager.

---

## Smoke Test Results (deterministic layer — all 6 pass)

| # | Prompt | Expected | Result |
|---|---|---|---|
| 1 | "Find 3 best locations for a premium cafe in Indiranagar." | topN=3, cafe/qsr archetype | ✅ PASS |
| 2 | "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro." | topN=5, dark_kitchen, outside_distance detected | ✅ PASS |
| 3 | "Find 20 sites for a premium clinic in Gurgaon." | requestedTopNRaw=20 → topNResolved=10, warning present | ✅ PASS |
| 4a | "Only rank my uploaded CSV points." + 5 valid points | ranked=3 (topN default), candidateSource=uploaded_point, no H3 leak | ✅ PASS |
| 4b | "Only rank my uploaded CSV points." + no points | blocked, 0 locations, hexGrid=[], constraintEnforcementLevel=enforced | ✅ PASS |
| 5 | "Find a site within 500 m of a metro station but outside 2 km of any metro station." | contradiction detected (1 found), no fake ranking | ✅ PASS |

**Note on live API smoke tests (prompts 1–3):** Full end-to-end execution (LLM + spatial engine + ORS) requires a live portal session. The deterministic layer (intent parser, output count, uploaded-candidates gate, contradiction detection) covers the new v1.1.0 constraints. Manual live testing should verify prompt 1 returns candidate zones (not "exact site"), prompt 2 shows the outside-metro advisory disclosure, and prompt 3 shows the cap warning in the ResultsDrawer.

---

## GitHub Actions CI Status

| Workflow | Trigger | Status |
|---|---|---|
| Deploy to GitHub Pages | push to master (61428ec) | ✅ success (28 s) |
| Backend Tests | push to master (61428ec) | ✅ success (29 s) |
| Deploy to GitHub Pages | push to master (e28f2f9) | ✅ success (28 s) |
| Backend Tests | push to master (504c6ff merge) | ✅ success (28 s) |

---

## Unresolved Issues / Known Limitations After Deploy

| Issue | Severity | Resolution |
|---|---|---|
| Critic disabled in default `low` mode | Known/intentional | Set `STRATAGEO_MAX_LLM_COST_MODE=balanced` for client reports |
| Hard constraint gate for `outside_distance` / `within_distance` advisory (depends on LLM) | Medium | v1.2 — full blocking gate |
| Dead `resultCount`/`onResultCountChange` props in FloatingAssistant | Low | Cosmetic cleanup PR |
| Lint not configured | Low | No lint script in package.json |

---

## Rollback

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# Redeploy backend: gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
# Frontend redeploys automatically on next push to master
```
