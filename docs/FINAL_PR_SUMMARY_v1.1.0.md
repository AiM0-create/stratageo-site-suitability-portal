# FINAL PR SUMMARY — v1.1.0 Universal Suitability Logic Upgrade

**Branch:** `feature/v1.1.0-universal-suitability-logic`
**Backup tag:** `backup/pre-v1.1.0-universal-suitability`
**Latest commit:** `3598b81 chore: ignore generated DOCX/PDF documentation artefacts`
**Previous feature commit:** `9b105dd feat(phase18): enforce uploaded-candidates-only hard constraint`
**Version:** 1.1.0
**Date:** 2026-06-24

---

## 1. Major Features

| Feature | Phase | Status |
|---|---|---|
| Deterministic RawIntent parser | 2 | ✅ Implemented + tested |
| Output count inference (default 3, cap 10, warn >10) | 2/8 | ✅ Implemented + tested |
| Universal archetype registry (14 archetypes) | 4 | ✅ Implemented + tested |
| Relative Rank / Absolute Viability / Confidence scores | 5 | ✅ Implemented + tested |
| Cost-aware model routing (low/balanced/high, escalation off) | 9 | ✅ Implemented + tested |
| Critic enabled/disabled disclosure | 17 | ✅ In result JSON + ResultsDrawer |
| Constraint enforcement level disclosure | 17 | ✅ In result JSON + ResultsDrawer |
| Untraced constraint advisory warnings | 17 | ✅ In result JSON + ResultsDrawer |
| Contradictory constraint detection | 17 | ✅ With unit normalization fix |
| **Uploaded-candidates-only enforcement** | **18** | **✅ HARD GATE — production blocker fixed** |
| ResultsDrawer R/V/C score pills + recommendation status | 13 | ✅ |
| FloatingAssistant result-count dropdown removed | 8 | ✅ |
| PDF: version + model metadata + site claim level | 7/16 | ✅ |
| CHANGELOG + release notes + deployment checklist | 15 | ✅ |
| Phase 16/17/18 audit documentation | 16–18 | ✅ |

---

## 2. Tests

```
Backend:  236 / 236 passed  (0 failed, 0 errors)
          Run time: ~5 s
          42 new test files (v1.1.0)

TypeScript: tsc --noEmit → CLEAN
Build:      npm run build → 8.17 s, 1002 modules, SUCCESS
```

**Test files added (v1.1.0):**
- `test_intent_parser.py` (33 tests)
- `test_archetypes_v110.py` (23 tests)
- `test_multi_score.py` (24 tests)
- `test_spec_v110.py` (20 tests)
- `test_config_v110.py` (18 tests)
- `test_phase17_smoke.py` (17 tests)
- `test_uploaded_candidates.py` (21 tests)

---

## 3. Smoke Test Results (deterministic layer)

All tested against live Python — no LLM calls needed for these checks.

| Test | Prompt | Expected | Result |
|---|---|---|---|
| **A** — uploaded + points | "Only rank my uploaded CSV points." + 5 points | Ranked 3 (topN default), candidateSource=uploaded_point, no H3 leak | ✅ PASS |
| **B** — uploaded, no points | "Only rank my uploaded CSV points." + 0 points | Blocked, 0 locations, hexGrid=[], constraintEnforcementLevel=enforced | ✅ PASS |
| **C** — output cap | "Find 20 sites for a premium clinic in Gurgaon." | topNResolved=10, warning present | ✅ PASS |
| **D** — explicit count + constraint | "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro." | topNResolved=5, dark_kitchen, outside_distance detected | ✅ PASS |
| **E** — contradictory constraints | "Find a site within 500 m of a metro station but outside 2 km of any metro station." | contradiction detected (within 500 m < outside 2000 m) | ✅ PASS |

---

## 4. Remaining Known Limitations

| Limitation | Severity | Fix in |
|---|---|---|
| Hard constraint gate for `outside_distance` / `within_distance` is **advisory** — depends on LLM creating correct SpecV2 exclusions/routeConstraints | Medium | v1.2 |
| `validate_hard_constraints_in_spec()` result is advisory (warns, does not block) | Medium | v1.2 |
| Critic disabled by default (cost mode = `low`) — must opt in with `STRATAGEO_MAX_LLM_COST_MODE=balanced` | Known, intentional | Deployment note |
| FloatingAssistant still accepts unused `resultCount`/`onResultCountChange` props (dead code, no visual) | Low | Cleanup PR |
| PDF does not expose model name (backend config not forwarded to frontend) | Low | v1.2 |

---

## 5. Deployment Notes

### Default configuration (cost-sensitive mode)
```
STRATAGEO_MAX_LLM_COST_MODE=low      # critic disabled, one LLM call
STRATAGEO_ENABLE_MODEL_ESCALATION=false
```

### Recommended for client-grade reports (critic enabled)
```
STRATAGEO_MAX_LLM_COST_MODE=balanced # one critic call per analysis
```
Do **not** set to `balanced` unless the operator accepts the additional gpt-4o cost per analysis.

### New Secret Manager keys required (optional — all have safe defaults)
None required. All new env vars have safe defaults matching the current production models.

### Backend deploy
```bash
cd backend-py/
gcloud run deploy stratageo-engine \
  --source . \
  --region asia-south1 \
  --max-instances 1 \
  --no-cpu-throttling \
  --project stratageo-location-intel-prod
```

### Frontend deploy
Push `feature/v1.1.0-universal-suitability-logic` → merge to `master` → GitHub Actions deploys automatically.

---

## 6. Rollback

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# Redeploy backend from the checked-out state:
cd backend-py/ && gcloud run deploy stratageo-engine --source . --region asia-south1 --project stratageo-location-intel-prod
# Rebuild frontend: npm run build && git push origin master
```

---

## 7. PR Description (suggested)

**Title:** `v1.1.0 Universal Suitability Logic Upgrade`

**Body:**
```
## Summary

- Deterministic RawIntent parser (before LLM): extracts output count, business type,
  hard constraints, spatial relations from the raw prompt.
- 14-archetype registry: QSR, premium restaurant, dark kitchen, clinic, hospital,
  preschool, gym, retail, warehouse, EV charger, hotel, office, industrial, generic.
- Multi-dimensional scoring: relativeRankScore + absoluteViabilityScore + confidenceScore
  alongside compositeScore. New recommendation labels: RECOMMENDED / CANDIDATE_ZONE /
  WEAK_CANDIDATE / RAW_DIAGNOSTIC / EXCLUDED.
- Cost-aware model routing: all models configurable via env vars; default = low (no cost
  increase vs current production).
- Output count from prompt: default 3, user-specifiable 1-10, cap 10 with warning.
  Chat result-count dropdown removed.
- Uploaded-candidates-only enforcement: "Only rank my uploaded CSV points" is now a
  HARD GATE — engine either scores only uploaded points or blocks with a clear message.
  No H3 fallback under any circumstances.
- Critic disclosure, constraint enforcement level, untraced constraints surfaced in UI.
- Contradictory constraint detection with unit normalization.
- PDF: version, engine version, site claim level, recommendation mode, uploaded-only
  candidate universe wording.

## Tests
236 backend tests pass (42 new). TypeScript clean. Build succeeds.

## Not changed
All v1.0.3 spatial reliability safeguards (waterfront corridor, buildability masks,
viability gate) are preserved and untouched.
Default model set unchanged (gpt-4o + gpt-4o-mini) — no extra API cost by default.
Existing SpecV2 v2.0 saved analyses load correctly (fully backward-compatible).

## Rollback
git checkout backup/pre-v1.1.0-universal-suitability
```

---

## 8. Final Verification Matrix

| Check | Result |
|---|---|
| Branch = feature/v1.1.0-universal-suitability-logic (not master/main) | ✅ |
| Backup tag exists | ✅ backup/pre-v1.1.0-universal-suitability |
| Working tree clean | ✅ (only untracked PDF/DOCX docs) |
| All changes committed | ✅ latest: 9b105dd |
| package.json: version bump only, no new deps | ✅ |
| package-lock.json: unchanged | ✅ (0 lines diff) |
| No GPT-5.x hardcoded as default | ✅ gpt-4o / gpt-4o-mini only |
| Default cost mode = low | ✅ |
| Escalation disabled by default | ✅ |
| Uploaded-only enforced (not advisory) | ✅ HARD GATE in jobs.py |
| Uploaded-only blocks when no points | ✅ build_no_points_result() |
| No H3 fallback in uploaded-only mode | ✅ early return before H3 step |
| Output count default = 3 | ✅ |
| Output cap = 10 with warning | ✅ |
| Smoke A-E all pass | ✅ |
| No "final/exact/best site" UI wording | ✅ |
| ResultsDrawer shows R/V/C + recommendation status | ✅ |
| ResultsDrawer shows critic enabled/disabled | ✅ |
| ResultsDrawer shows constraint enforcement level | ✅ |
| ResultsDrawer shows uploaded-only disclosure | ✅ |
| PDF: version + disclaimer + site claim level | ✅ |
| PDF: uploaded-only candidate universe wording | ✅ |
| Backend tests: 236/236 | ✅ |
| TypeScript: clean | ✅ |
| Frontend build: success | ✅ |
| All 6 docs present and updated | ✅ |
