# Post-Deploy Smoke Test Report — v1.1.2

**Date/time:** 2026-06-24 ~13:00 UTC
**Backend revision:** stratageo-engine-00033-ccm (Cloud Run, asia-south1)
**Frontend:** GitHub Pages — deploy-pages.yml workflow: success (26 s)
**Commit:** 0929d8b fix: restore water tag helper for spatial masks

---

## /health

```json
{
  "appVersion": "1.1.2",
  "engineVersion": "1.1.2",
  "releaseName": "Water Tag Helper NameError Fix",
  "modelConfig": {
    "chatModel": "gpt-5.4-mini",
    "reasoningModel": "gpt-5.4-mini",
    "criticModel": "gpt-5.4",
    "reportModel": "gpt-5.4-nano",
    "fastModel": "gpt-5.4-nano",
    "escalationEnabled": false,
    "fallbackEnabled": false
  },
  "costMode": "low",
  "criticEnabled": false
}
```

**Health check:** `appVersion: 1.1.2` ✅ · model config unchanged from v1.1.1 ✅ · no secrets ✅

---

## Regression 1 — Exact crash prompt

**Prompt:** "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass"

| Field | Value |
|---|---|
| HTTP status | **200** ✅ |
| `_is_water_tag` NameError | **GONE** ✅ |
| Model | gpt-5.4-mini |
| Stage | chat |
| Tokens | 14,300 |
| Reply excerpt | "You want a top-3 micro-market search for a student-focused quick-service cafe around Ruby Crossing and the EM Bypass. Th..." |
| Raw Python exception | None ✅ |
| Result | **PASS** ✅ |

---

## Regression 2 — Output cap (20 → 10)

**Prompt:** "Find 20 sites for a premium clinic in Gurgaon."

| Field | Value |
|---|---|
| HTTP status | **200** ✅ |
| Model | gpt-5.4-mini |
| Tokens | 13,650 |
| Result | **PASS** ✅ |

---

## Regression 3 — Uploaded-only no CSV

**Prompt:** "Only rank my uploaded CSV points." (no CSV uploaded)

| Field | Value |
|---|---|
| HTTP status | **200** ✅ |
| H3 fallback | No ✅ |
| Clear user message | Yes ✅ |
| Result | **PASS** ✅ |

---

## Summary

| Check | Result |
|---|---|
| /health appVersion = 1.1.2 | ✅ |
| `_is_water_tag` NameError resolved | ✅ |
| Exact crash prompt: HTTP 200 | ✅ |
| Output cap regression: PASS | ✅ |
| Uploaded-only regression: PASS | ✅ |
| Model unchanged (gpt-5.4-mini) | ✅ |
| Backend tests 267/267 | ✅ |
| Frontend build success | ✅ |

---

## Rollback

```bash
git checkout backup/pre-v1.1.2-water-tag-hotfix
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```
