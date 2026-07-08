# Phase 16 Strict Audit — v1.1.0 Universal Suitability Logic Upgrade

**Audit date/time:** 2026-06-24
**Branch:** `feature/v1.1.0-universal-suitability-logic`
**Backup tag:** `backup/pre-v1.1.0-universal-suitability`
**Audited by:** Claude (Phase 16 audit pass)

---

## 1. Cost-Mode Verification

| Check | Result |
|---|---|
| Default cost mode | **Changed `balanced` → `low`** (Phase 16 fix) |
| `STRATAGEO_MAX_LLM_COST_MODE` default | `"low"` (line 59 `config.py`) |
| Escalation default | `STRATAGEO_ENABLE_MODEL_ESCALATION = false` ✅ |
| Critic in `low` mode | **OFF** — `critic_active` property returns `False` when `cost_mode == "low"` ✅ |
| Escalation requires explicit env opt-in | ✅ — `stratageo_enable_model_escalation: bool = False` hardcoded |

**Finding (FIXED):** The original commit set the default to `"balanced"`. This was incorrect for a cost-sensitive upgrade. Default has been corrected to `"low"`.

---

## 2. Model Default Verification

All defaults confirmed at `backend-py/app/config.py` lines 44-48:

```
L44: stratageo_chat_model: str = "gpt-4o"
L45: stratageo_reasoning_model: str = "gpt-4o"
L46: stratageo_critic_model: str = "gpt-4o"
L47: stratageo_report_model: str = "gpt-4o-mini"
L48: stratageo_fast_model: str = "gpt-4o-mini"
L55: stratageo_escalation_model: str = ""  (empty = falls back to chat model)
```

No GPT-5.x or pro-tier model hardcoded anywhere. ✅

`/health` exposes `modelConfig` (names only, no key values) and `costMode`. ✅
`model_config_public()` tested to never leak `sk-*` keys. ✅

---

## 3. Git Safety Verification

```
Branch:    feature/v1.1.0-universal-suitability-logic  (NOT master/main) ✅
Tag:       backup/pre-v1.1.0-universal-suitability  ✅
Clean:     Only STRATAGEO_TECHNICAL_DOCUMENTATION.docx/.pdf untracked (not committed) ✅
Commit:    12047f7 feat: v1.1.0 Universal Suitability Logic Upgrade
```

Working tree: clean (no uncommitted changes on the feature branch after audit commit).

---

## 4. Diff Review

Files changed vs baseline (`backup/pre-v1.1.0-universal-suitability`):
- 24 files, +2634 lines / -65 lines
- `package.json`: version bump only (`1.0.3` → `1.1.0`), no new dependencies ✅
- `package-lock.json`: unchanged ✅
- No `docx` or other test-tool dependencies committed ✅
- No secrets or local paths committed ✅
- No Cloud Run deployment config changed ✅
- No `.env` or `.env.local` files committed ✅

---

## 5. RawIntent Traceability Audit

| Prompt | topNResolved | requestedTopNRaw | Warning | Biz type | Hard constraints |
|---|---|---|---|---|---|
| "Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro." | **5** ✅ | 5 | — | dark_kitchen ✅ | outside_distance, avoid_anchor ✅ |
| "Find 20 sites for a premium clinic in Gurgaon." | **10** ✅ (capped) | 20 | CAPPED WARNING ✅ | clinic ✅ | — |
| "Find one warehouse near NH44 but away from dense residential areas." | **1** ✅ | 1 | — | warehouse ✅ | avoid_anchor ✅ |
| "Find the best cafe in Indiranagar." | **3** ✅ (default) | None | — | cafe ✅ | — |
| "Only rank my uploaded CSV points." | **3** (default) | None | — | generic | uploaded_candidates ✅ |

**Bug found and fixed (Phase 16):** "Find top 5" was returning `topNResolved=3` because the count regex was missing `\s+` between keyword and number. Fixed by rewriting the regex pattern with explicit spacing and multi-word lead support.

**Hard constraint traceability:** Hard constraint phrases extracted at parser level, available in `spec.rawIntent.hardConstraintPhrases`. The LLM consultant is responsible for mapping these to SpecV2 exclusions/corridors/routeConstraints/studyArea. The `validate_hard_constraints_in_spec()` function can be called post-LLM to check for missing gates (currently called but not yet blocking — flagged as known gap below).

---

## 6. UI Verification

| Check | Result |
|---|---|
| FloatingAssistant result-count dropdown removed | ✅ — `<select>` element gone; comment left explaining why |
| Props (`resultCount`, `onResultCountChange`) still in interface | ⚠️ **Known gap** — props are unused but remain in the type interface and App.tsx. No visual effect, no crash. Acceptable for PR; cleanup is cosmetic. |
| ResultsDrawer shows R/V/C score pills | ✅ — shows when `relativeRankScore !== undefined` (v1.1.0 data only) |
| ResultsDrawer shows recommendation status label | ✅ — `getRecommendationLabel()` replaces `getScoreQualityLabel()` as primary label |
| "best site" / "final site" wording | ✅ — not found in any UI component |
| Raw/withheld markers preserved from v1.0.3 | ✅ — no regression |

---

## 7. Report Export Verification

### Gaps found and fixed (Phase 16):

| Field | Status Before | Status After Fix |
|---|---|---|
| App version on cover | ❌ Missing | ✅ Added (`App v1.1.0 \| Engine v1.1.0`) |
| Recommendation mode on cover | ❌ Missing | ✅ Added |
| Site claim level on cover | ❌ Missing | ✅ Added |
| Disclaimer on cover | ✅ Existed | ✅ Preserved |
| Version metadata page | ❌ Missing | ✅ Added (methodology section 5) |

### Remaining PDF gaps (not fixed — scope for v1.2):
- **model/cost mode** not exposed in PDF (backend config not sent to frontend)
- **requested vs returned output count** not shown explicitly
- **confidence section** is minimal (just a single label, not per-source breakdown)
- **missing/unvalidated data warnings** from `modelDisclosure` not yet surfaced in PDF

These are **known gaps** documented below. PDF is improved but does not yet fully meet the v1.1.0 Phase 12 spec for report quality. Safe to PR; full PDF upgrade can be Phase 17.

---

## 8. Regression Test Verification

### Backend

```
Command: .venv/Scripts/python -m pytest tests/ -q
Result:  198 passed / 0 failed / 0 errors
Time:    4.49s
```

**New tests in this feature branch (104 total):**
- `test_intent_parser.py` — 33 tests
- `test_archetypes_v110.py` — 23 tests
- `test_multi_score.py` — 24 tests
- `test_spec_v110.py` — 20 tests
- `test_config_v110.py` — 18 tests (includes Phase 16 audit fix: `test_default_cost_mode_is_low`)

**Existing test suites (94 tests from v1.0.x):** All pass without modification.

### Frontend

```
Command: npx tsc --noEmit
Result:  CLEAN (no output = no errors)

Command: npm run build
Result:  Build succeeded in 9.67s (1002 modules)
Warning: Chunk size 1055 kB (pre-existing, not introduced by this upgrade)
```

---

## 9. Unresolved Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `resultCount`/`onResultCountChange` props still in `FloatingAssistant` interface and App.tsx | Low | Cosmetic/dead code; no visual element; tsc clean. Remove in cleanup PR. |
| `validate_hard_constraints_in_spec()` called in `llm.py` but result logged only, not blocking | Medium | Hard constraint gate is advisory in v1.1.0. Blocking gate is Phase 2 of v1.2. Honest gap. |
| PDF does not expose model name or cost mode | Low | Backend config not forwarded to frontend; requires API change. Documented for v1.2. |
| `prompts.py` system prompt is ~30% longer (engine playbook injected) | Low | Monitor gpt-4o token usage on first 10 live runs. Expected latency increase: <1s. |
| `low` cost mode disables the critic by default | Medium | This is intentional per cost-sensitivity requirement. Operators who want the critic must set `STRATAGEO_MAX_LLM_COST_MODE=balanced` in Secret Manager. Document in deployment checklist. |
| Output count override only fires when `requestedTopNRaw is not None` | Low | If user says "find me locations" with no count, default 3 applies — correct. No risk. |
| "Find the best cafe" → topN=3 (default) | Low | "best" alone without a number = default 3. Correct per spec. |

---

## 10. Manual Smoke Prompts

Run these on the live portal **after** merging to master and deploying:

1. `"Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro."` → expect topN=5 in spec.output.topN, outside_distance in rawIntent.spatialRelations
2. `"Find 20 sites for a premium clinic in Gurgaon."` → expect topN=10 (capped), warning visible in ResultsDrawer
3. `"Find one warehouse near NH44 but away from dense residential areas."` → expect topN=1
4. `"Find the best cafe in Indiranagar."` → expect topN=3 (default)
5. `"Find top 3 premium restaurants along the Hooghly River strictly between Howrah Bridge and Vidyasagar Setu."` → waterfront corridor + insufficient_viable_land (or withheld)
6. `"Find a resort location in a scenic low-density area near Dehradun."` → hotel/resort archetype
7. Impossible prompt: `"Find a restaurant strictly within Howrah Bridge AND at least 10km from any road."` → infeasibility surfaced
8. Check `/health` endpoint → confirms version 1.1.0, costMode="low", escalationEnabled=false

---

## Rollback command

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# Redeploy backend: gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
# Rebuild frontend: npm run build && git push origin master
```

---

## Final Recommendation

**SAFE TO OPEN PR** — with the following caveats documented above:

1. The `resultCount`/`onResultCountChange` props are dead code in FloatingAssistant — cosmetic cleanup only, no functional impact.
2. Hard constraint validation gate is advisory (logs, not blocks). Full blocking gate is scoped to v1.2.
3. PDF model/cost disclosure is partial — the backend config is not forwarded to frontend. Documented for v1.2.
4. Operators who want the critic (recommended for production quality) must explicitly set `STRATAGEO_MAX_LLM_COST_MODE=balanced` in Secret Manager before deployment.
