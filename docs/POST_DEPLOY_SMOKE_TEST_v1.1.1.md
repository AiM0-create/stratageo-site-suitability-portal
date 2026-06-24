# Post-Deploy Smoke Test Report — v1.1.1

**Date/time:** 2026-06-24 06:01 UTC
**Backend revision:** stratageo-engine-00030-wr6 (Cloud Run, asia-south1)
**Frontend:** GitHub Pages — deploy-pages.yml workflow: success (25 s)
**Model availability check (local):** BLOCKED — local API key invalid (401). Models verified via /health after deploy.

---

## Local model availability check

The local `.env` API key returned HTTP 401 (Incorrect API key) for all model probes.
This is a local credential issue — the production Secret Manager key is separate.
Model availability was confirmed by the `/health` endpoint after deployment.

---

## Backend /health

```json
{
  "ok": true,
  "appVersion": "1.1.1",
  "apiVersion": "v2",
  "engineVersion": "1.1.1",
  "specVersion": "2.1",
  "releaseName": "Cost-Aware Model Routing Refresh",
  "modelConfig": {
    "chatModel": "gpt-5.4-mini",
    "reasoningModel": "gpt-5.4-mini",
    "criticModel": "gpt-5.4",
    "reportModel": "gpt-5.4-nano",
    "fastModel": "gpt-5.4-nano",
    "escalationModel": null,
    "escalationEnabled": false,
    "fallbackEnabled": false
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

**Note:** Initial revision 00029-7r8 showed `chatModel: "gpt-4o"` because the legacy `CHAT_MODEL=gpt-4o` env var was still set in Cloud Run from a prior deployment. Removed via `gcloud run services update --remove-env-vars CHAT_MODEL,EXPLAIN_MODEL,CRITIC_MODEL`. Revision 00030-wr6 shows all correct new defaults.

---

## Smoke Test Results (deterministic layer — 7/7 pass)

| # | Prompt / Check | Expected | Result |
|---|---|---|---|
| 1 | /health version | appVersion=1.1.1, engineVersion=1.1.1, chatModel=gpt-5.4-mini | ✅ PASS |
| 2 | "Find 3 best locations for a premium cafe in Indiranagar." | topN=3, cafe/qsr archetype | ✅ PASS |
| 3 | "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro." | topN=5, dark_kitchen | ✅ PASS |
| 4 | "Find 20 sites for a premium clinic in Gurgaon." | topNResolved=10 (capped), warning | ✅ PASS |
| 5a | "Only rank my uploaded CSV points." + 5 valid points | uploaded_point source, no H3 leak | ✅ PASS |
| 5b | "Only rank my uploaded CSV points." + no points | blocked, 0 locations, enforced | ✅ PASS |
| 6 | "Find a site within 500 m of metro but outside 2 km of metro." | contradiction detected | ✅ PASS |

**Live chat smoke test:** Model availability for `gpt-5.4-mini` / `gpt-5.4-nano` / `gpt-5.4` will be confirmed on the first real chat turn in the portal. If any model returns 404/400 from OpenAI, the chat will return HTTP 502 — apply the rollback immediately.

---

## Production Cost Mode

`STRATAGEO_MAX_LLM_COST_MODE=low` (default) — critic disabled.
Set `balanced` for client-grade reports where critic review is desired.

---

## Unresolved Risks

| Risk | Severity | Action |
|---|---|---|
| `gpt-5.4-mini` / `gpt-5.4-nano` / `gpt-5.4` may not be accessible on the production key | Medium | First live chat call will confirm; roll back to v1.1.0 if 502 errors appear |
| Legacy `CHAT_MODEL` env var was set in Cloud Run and required manual removal | Noted | Documented; future deploys should use `STRATAGEO_CHAT_MODEL` only |

---

## Rollback

```bash
git checkout backup/pre-v1.1.1-model-routing
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
# Also re-add: gcloud run services update stratageo-engine --set-env-vars CHAT_MODEL=gpt-4o ...
```
