# Deployment Checklist — v1.1.0 Universal Suitability Logic Upgrade

## Pre-deployment

| Check | Status |
|---|---|
| Backup tag created | `backup/pre-v1.1.0-universal-suitability` ✅ |
| Feature branch name | `feature/v1.1.0-universal-suitability-logic` ✅ |
| Baseline documented | `docs/upgrade_backups/V1.1.0_BASELINE.md` ✅ |
| Backend unit tests | `197 passed / 0 failed` ✅ |
| New v1.1.0 tests | `104 new tests (intent_parser, archetypes, multi_score, spec, config)` ✅ |
| Frontend TypeScript | `tsc --noEmit` clean ✅ |
| Frontend build | Run `npm run build` before deploying |
| CHANGELOG updated | `CHANGELOG.md` ✅ |
| Release notes | `docs/RELEASE_NOTES_v1.1.0.md` ✅ |

## Test commands

```bash
# Backend tests (run from backend-py/)
.venv/Scripts/python -m pytest tests/ -q

# Frontend typecheck
npx tsc --noEmit

# Frontend build
npm run build
```

## Environment variables required (new in v1.1.0)

All new variables have safe defaults — **zero config change needed** for existing deployments.

| Variable | Default | Notes |
|---|---|---|
| `STRATAGEO_CHAT_MODEL` | `gpt-4o` | Same as old `CHAT_MODEL` |
| `STRATAGEO_REASONING_MODEL` | `gpt-4o` | New — uses chat model by default |
| `STRATAGEO_CRITIC_MODEL` | `gpt-4o` | Same as old `CRITIC_MODEL` |
| `STRATAGEO_REPORT_MODEL` | `gpt-4o-mini` | Same as old `EXPLAIN_MODEL` |
| `STRATAGEO_FAST_MODEL` | `gpt-4o-mini` | New — cheapest existing model |
| `STRATAGEO_ENABLE_MODEL_ESCALATION` | `false` | Keep false in prod to avoid cost increase |
| `STRATAGEO_MAX_LLM_COST_MODE` | `balanced` | `low` / `balanced` / `high` |

Old env vars (`CHAT_MODEL`, `CRITIC_MODEL`, `EXPLAIN_MODEL`) still work and take priority.

## Feature flags (all enabled by default)

Set to `false` in `.env` to disable individual features without redeploying:

```
ENABLE_RAW_INTENT_PARSER=true
ENABLE_UNIVERSAL_ARCHETYPES=true
ENABLE_MULTI_SCORE_OUTPUT=true
ENABLE_UNIVERSAL_CRITIC=true
```

## Backend deployment (Cloud Run)

```bash
cd backend-py/
gcloud run deploy stratageo-engine \
  --source . \
  --region asia-south1 \
  --max-instances 1 \
  --no-cpu-throttling \
  --project stratageo-location-intel-prod
# Secrets are already set — no --set-secrets needed
```

## Frontend deployment (GitHub Pages via CI)

The GitHub Actions workflow triggers automatically on push to master.
Merge feature branch → master to deploy.

## Rollback instructions

```bash
# Rollback to v1.0.3 immediately:
git checkout backup/pre-v1.1.0-universal-suitability

# Redeploy backend from backup:
cd backend-py/
gcloud run deploy stratageo-engine --source . --region asia-south1 --project stratageo-location-intel-prod

# Rebuild and redeploy frontend:
git checkout backup/pre-v1.1.0-universal-suitability
npm run build
git push origin master  # triggers CI deploy
```

## Known risks

| Risk | Mitigation |
|---|---|
| `prompts.py` system prompt is longer (+archetype registry) | Monitor gpt-4o token usage on first live runs |
| `spec.py` accepts `version: "2.0"` and `"2.1"` | Old saved analyses still load correctly — tested |
| FloatingAssistant result-count dropdown removed | Count comes from prompt via RawIntent parser. Users who type "find 5 locations" get 5. Users who don't specify get the default of 3. |
| Multi-score adds fields to every location dict | Frontend is backward-compatible — new fields are optional |

## Manual smoke test prompts (Phase 15)

Run these on the live portal after deployment:

1. `"Find 3 best locations for a premium cafe in Indiranagar."` → expect topN=3, premium_restaurant archetype
2. `"Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro."` → topN=5, dark_kitchen, outside_distance spatial relation
3. `"Find 20 sites for a premium clinic in Gurgaon."` → topN=10 (capped), warning shown, maternity_clinic or clinic archetype
4. `"Find a warehouse near NH44 but away from dense residential areas."` → warehouse archetype, highway feature
5. `"Find a resort location in a scenic low-density area near Dehradun."` → hotel/resort archetype
6. `"Find sites only from my uploaded CSV points."` → hasUploadedCandidates=true
7. Impossible prompt: `"Find a restaurant strictly within Howrah Bridge AND at least 10km from any road."` → infeasibility flagged

---

## PR details

**Suggested PR title:**
> v1.1.0 Universal Suitability Logic Upgrade

**Suggested PR description:**

```markdown
## Summary

- **Deterministic RawIntent parser** (`engine/intent_parser.py`): extracts topN, 
  businessType, hard constraints, and spatial relations before the LLM.
- **14-archetype registry** (`engine/archetypes.py`): QSR, premium restaurant, dark 
  kitchen, clinic, hospital, preschool, gym, retail, warehouse, EV charger, hotel, 
  office, industrial, generic.
- **Multi-dimensional scoring** (`engine/multi_score.py`): relativeRankScore + 
  absoluteViabilityScore + confidenceScore alongside compositeScore.
- **SpecV2 v2.1 extensions** (backward-compatible): rawIntent, analysisMode, 
  recommendationMode, siteClaimLevel, outputCount, modelDisclosure, dataConfidence.
- **Cost-aware model routing**: all models configurable via env vars; 
  STRATAGEO_MAX_LLM_COST_MODE=balanced by default (no cost increase).
- **Output count from prompt**: default 3, user-specifiable 1–10, cap 10 with warning. 
  Chat dropdown removed.
- **Universal critic contract**: shouldWithholdRecommendations, recommendationModeOverride, 
  downgrades, confidenceAdjustment.
- **Recommendation labels**: RECOMMENDED / CANDIDATE_ZONE / WEAK_CANDIDATE / 
  RAW_DIAGNOSTIC / EXCLUDED replacing STRONG/VIABLE/WEAK.
- **197 backend tests pass** (104 new). Frontend tsc clean.

## Not changed
- All v1.0.3 spatial reliability safeguards (waterfront, buildability, viability gate)
- Cloud Run deployment config
- Default model set (gpt-4o + gpt-4o-mini)
- Existing SpecV2 v2.0 saved analyses load correctly

## Rollback
`git checkout backup/pre-v1.1.0-universal-suitability` and redeploy.
```
