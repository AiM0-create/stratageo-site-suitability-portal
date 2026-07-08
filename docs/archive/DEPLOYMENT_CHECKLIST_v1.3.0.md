# Deployment Checklist — v1.3.0

## Pre-deploy checks

- [ ] All tests pass: `pytest` (excludes openai-dependent tests for local env)
- [ ] TypeScript: `npx tsc --noEmit` — clean
- [ ] Build: `npm run build` — success
- [ ] No secrets in committed files: `git diff --stat` — confirm no `.env`, no credentials
- [ ] `APP_VERSION = "1.3.0"` in `config.py`
- [ ] `ENGINE_VERSION = "1.3.0"` in `config.py`
- [ ] `package.json version: "1.3.0"`

## Backend deploy (Cloud Run)

```bash
gcloud run deploy stratageo-engine \
  --source backend-py/ \
  --region asia-south1 \
  --project stratageo-location-intel-prod
```

## Smoke test after deploy

1. `GET /health` — confirm `appVersion: "1.3.0"`, `engineVersion: "1.3.0"`, `featureFlags.evidenceTrail: true`
2. Run Ruby Crossing prompt: "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass"
3. Confirm `planningFingerprint = pfp_bbe4571fe559` (stable from v1.2.0)
4. Confirm `evidenceTrail` present in result JSON
5. Confirm `evidenceTrail.evidenceVersion = "1.3.0"`
6. Confirm `evidenceTrail.prompt.archetypeKey = "student_qsr_cafe"`
7. Confirm `len(evidenceTrail.factors) = 5`
8. Confirm `evidenceTrail.providerQueries` is a non-empty list
9. Test `GET /api/v2/analyses/{jobId}/evidence` — returns evidence trail
10. Test `GET /api/v2/analyses/{jobId}/evidence.json` — downloads JSON file
11. Confirm no `api_key`, `authorization`, `token`, `secret` keys in evidence JSON

## Frontend deploy (GitHub Pages)

Push to master → `deploy-pages.yml` auto-deploys.

## Evidence tab smoke test (UI)

1. Open portal → run Ruby Crossing analysis
2. In ResultsDrawer, scroll to "🔍 Evidence Trail" section
3. Expand — verify all 7 sections load without errors
4. Expand a factor in "Factor Evidence" — verify per-candidate table shows raw/normalized/weighted scores
5. Click "↓ Export Evidence JSON" — verify file downloads and is valid JSON
6. Verify no `sk-`, `Bearer`, or API key values in downloaded JSON

## Rollback

```bash
git checkout backup/pre-v1.3.0-evidence-trail
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```
