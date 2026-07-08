# Post-Deploy Real Model Call Verification — v1.1.1

**Date/time:** 2026-06-24 06:25 UTC
**Backend revision:** stratageo-engine-00032-fck (Cloud Run, asia-south1)
**Final master commit:** 5249cb2 — fix: replace max_tokens with max_completion_tokens for gpt-5.x compat

---

## Bugs found and fixed during this verification pass

Two production bugs were caught by the live call test (not by unit tests, because tests mock the OpenAI API):

### Bug 1 — `UnboundLocalError: last_user` in `llm.py`  (commit `df9cfce`)

**Symptom:** HTTP 502 on every chat call.

**Root cause:** `parse_raw_intent(last_user)` was added at line 147 during the v1.1.0 upgrade, but `last_user = next(...)` was still assigned later at line 172. Python's function-scoping rule: any name that appears on the left-hand side of an assignment anywhere in a function is treated as local to the whole function. Referencing `last_user` before that assignment raises `UnboundLocalError`. Identical class of bug to the earlier `engine_playbook` fix (commit `52ba7fa`).

**Fix:** Moved `last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")` to immediately before `parse_raw_intent(last_user)`. Removed the now-duplicate later assignment.

### Bug 2 — `max_tokens` unsupported by gpt-5.x models  (commit `5249cb2`)

**Symptom:** HTTP 502 / `openai.BadRequestError 400 — 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`

**Root cause:** The gpt-5.4 family (and all gpt-5.x models) require `max_completion_tokens` instead of the deprecated `max_tokens` parameter. All three OpenAI call sites in the backend still used `max_tokens`.

**Fix:** Changed `max_tokens=N` → `max_completion_tokens=N` in:
- `services/llm.py` (chat turns — 4000 tokens)
- `services/critic.py` (post-exec critic — 1200 tokens)
- `engine/results.py` (per-candidate explanations — 1200 tokens)

`max_completion_tokens` is backward-compatible with gpt-4o and gpt-4o-mini, so the legacy fallback path also works.

---

## Step 1 — /health

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
  "criticEnabled": false,
  "hasOpenAIKey": true,
  "hasPlacesKey": true,
  "hasOrsKey": true
}
```

| Check | Result |
|---|---|
| appVersion = 1.1.1 | ✅ |
| engineVersion = 1.1.1 | ✅ |
| chatModel = gpt-5.4-mini | ✅ |
| reasoningModel = gpt-5.4-mini | ✅ |
| criticModel = gpt-5.4 | ✅ |
| reportModel = gpt-5.4-nano | ✅ |
| fastModel = gpt-5.4-nano | ✅ |
| costMode = low | ✅ |
| criticEnabled = false | ✅ |
| No secrets exposed | ✅ |

---

## Step 2 — Real chat call: "Find 3 best locations for a premium cafe in Indiranagar."

| Field | Value |
|---|---|
| HTTP status | **200** ✅ |
| Model confirmed | **gpt-5.4-mini** ✅ |
| Stage | chat |
| specStatus | draft |
| Tokens used | 14,220 |
| Reply excerpt | "I'm mapping this as a premium cafe micro-market search in Indiranagar — the right lens is footfall + premium co-tenancy + frontage, not residential density." |
| Fallback to gpt-4o | No |
| 5xx / 401 / 403 / 429 error | None |
| Result | **PASS** ✅ |

---

## Step 3 — Output-count check: "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro."

| Field | Value |
|---|---|
| HTTP status | **200** ✅ |
| Model confirmed | **gpt-5.4-mini** ✅ |
| Stage | framework (full spec built in single turn) |
| topN in spec | **5** ✅ |
| topNResolved | **5** ✅ |
| businessTypeKey | dark_kitchen ✅ |
| spatialRelations | outside_distance, near_anchor, avoid_anchor ✅ |
| Reply excerpt | "**Objective** — Find top 5 dark kitchen candidate zones near Ballygunge Phari, while staying outside 1 km of any metro" |
| Overclaiming "exact/final site" | No — candidate zone wording used ✅ |
| Result | **PASS** ✅ |

---

## Step 4 — Uploaded-only no-points check: "Only rank my uploaded CSV points."

| Field | Value |
|---|---|
| HTTP status | **200** ✅ |
| Model confirmed | **gpt-5.4-mini** ✅ |
| Stage | chat |
| H3 fallback triggered | No (chat stage — no analysis executed yet) |
| LLM / model error | None ✅ |
| Reply excerpt | "You want me to rank only the points in your uploaded CSV, with no extra geography or assumptions beyond the file itself. I can do that, but I'll need the CSV-..." |
| User-facing message | Clear — assistant asks for the CSV before proceeding |
| Backend engine hard-block | Enforced when `uploadedCandidatesOnly=true` + no points provided (tested in unit tests; chat stage precedes execution) |
| Result | **PASS** ✅ |

---

## Summary

| Check | Result |
|---|---|
| /health — all model names correct | ✅ |
| gpt-5.4-mini accessible via production API key | ✅ |
| max_completion_tokens accepted (gpt-5.x compat) | ✅ |
| Chat turns complete without 5xx | ✅ |
| topN=5 parsed and reflected in spec | ✅ |
| outside_distance spatial relation detected | ✅ |
| No fallback to gpt-4o | ✅ |
| No secrets in API responses | ✅ |
| Backend tests (246/246) | ✅ |
| Bugs fixed during verification | 2 (both committed to master) |

---

## Rollback command

```bash
git checkout backup/pre-v1.1.1-model-routing
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
# Also restore legacy env var: gcloud run services update stratageo-engine --set-env-vars CHAT_MODEL=gpt-4o ...
```
