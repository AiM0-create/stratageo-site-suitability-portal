# Deployment Checklist — v1.2.0

## Status: NOT YET DEPLOYED — feature/v1.2.0-deterministic-planning branch only

### Pre-merge checklist

| Check | Status |
|---|---|
| Feature branch created | `feature/v1.2.0-deterministic-planning` ✅ |
| Backup tag | `backup/pre-v1.2.0-deterministic-planning` ✅ |
| Backend tests | 291/291 ✅ |
| Golden tests | 24/24 ✅ |
| TypeScript | clean ✅ |
| Frontend build | success ✅ |

### New env vars (all have safe defaults — no Secret Manager change needed)

```
STRATAGEO_DETERMINISTIC_PLANNING=true   # already default in code
STRATAGEO_SPEC_TEMPERATURE=0.0          # temperature for spec-building calls
STRATAGEO_SPEC_SEED=42                  # seed for reproducibility
```

### Backend deploy

```bash
cd backend-py/
gcloud run deploy stratageo-engine \
  --source . \
  --region asia-south1 \
  --project stratageo-location-intel-prod
```

### Post-deploy smoke tests (manual)

Run the Ruby Crossing prompt twice in separate sessions:
"Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass"

Assert:
- Same archetypeKey: student_qsr_cafe
- Same factor table: student_catchment_proxy / pedestrian_transit_access / direct_cafe_competition / commercial_cotenancy / frontage_barrier_penalty
- Same weights: 32/27/18/14/9
- Same planningFingerprint

### Rollback

```bash
git checkout backup/pre-v1.2.0-deterministic-planning
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project stratageo-location-intel-prod
```
