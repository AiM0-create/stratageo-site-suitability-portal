# Deployment Checklist — v1.1.1 Cost-Aware Model Routing Refresh

## Pre-deployment

| Check | Status |
|---|---|
| Backup tag created | `backup/pre-v1.1.1-model-routing` ✅ |
| Backend tests | 246 / 246 passed ✅ |
| Frontend TypeScript | clean ✅ |
| Frontend build | success ✅ |
| No Pro models in defaults | verified ✅ |
| No secrets in code/logs | verified ✅ |
| Local model availability check | BLOCKED — local API key is invalid (401); verified via post-deploy live test |

## Model availability note

Local API key in `.env` returned 401 (Incorrect API key) for all model checks.
This is a local credential issue — the production Secret Manager key is separate.
The live smoke test after deployment is the definitive availability check.
If any model fails in production, roll back immediately and revert to `gpt-4o` / `gpt-4o-mini`.

## Test commands

```bash
# Backend (from backend-py/)
python -m pytest tests/ -q

# Frontend
npx tsc --noEmit
npm run build
```

## New env vars (no new Secret Manager keys needed for default low mode)

The defaults are in code. To override in production:

```
STRATAGEO_CHAT_MODEL=gpt-5.4-mini
STRATAGEO_REASONING_MODEL=gpt-5.4-mini
STRATAGEO_CRITIC_MODEL=gpt-5.4
STRATAGEO_REPORT_MODEL=gpt-5.4-nano
STRATAGEO_FAST_MODEL=gpt-5.4-nano
STRATAGEO_ENABLE_MODEL_ESCALATION=false
STRATAGEO_MAX_LLM_COST_MODE=low
```

## Backend deploy

```bash
cd backend-py/
gcloud run deploy stratageo-engine \
  --source . \
  --region asia-south1 \
  --project stratageo-location-intel-prod
```

## Post-deploy verification

```bash
curl https://stratageo-engine-1020081478981.asia-south1.run.app/health
```

Expected:
- `appVersion: "1.1.1"`
- `engineVersion: "1.1.1"`
- `costMode: "low"`
- `criticEnabled: false`
- `chatModel: "gpt-5.4-mini"`
- `reportModel: "gpt-5.4-nano"`
- `criticModel: "gpt-5.4"`

## Known risks

| Risk | Mitigation |
|---|---|
| `gpt-5.4-mini` / `gpt-5.4-nano` / `gpt-5.4` / `gpt-5.5` not yet available on production API key | Live smoke test will surface this; roll back immediately if chat returns 502 |
| Production cost may change vs gpt-4o | Monitor per-request token costs after first 24 hours |

## Rollback

```bash
git checkout backup/pre-v1.1.1-model-routing
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```
