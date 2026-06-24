## Summary

<!-- Brief description of the change and why it was made. -->

## Tests run

- [ ] `pytest tests/ -q` — all tests pass
- [ ] `npx tsc --noEmit` — TypeScript clean
- [ ] `npm run build` — build succeeds

**Test results:**

```
# paste output here
```

## Smoke tests

<!-- List any manual or deterministic smoke tests you ran. -->

- [ ] Prompt: "Find 3 best locations for a premium cafe in Indiranagar." — normal analysis, no overclaiming
- [ ] Output count cap: "Find 20 sites..." → capped at 10 with warning
- [ ] Uploaded-only with points: only uploaded candidates ranked, no H3 fallback
- [ ] Uploaded-only without points: blocked clearly
- [ ] Other: ___

## Screenshots (if UI changed)

<!-- Attach screenshots of ResultsDrawer, MapView, PDF export, or chat flow. -->

## Deployment impact

- [ ] No backend deploy needed
- [ ] Backend deploy required — Cloud Run `gcloud run deploy`
- [ ] Frontend deploy automatic on merge to master (GitHub Actions → Pages)
- [ ] New env vars required: ___
- [ ] Secret Manager update required: ___

## Rollback plan

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# Redeploy backend and rebuild frontend from the checked-out state.
```

## Secrets / config changes

- [ ] No secrets changed
- [ ] New Secret Manager keys added: ___
- [ ] Model defaults changed: ___
- [ ] Cost mode changed: ___

<!-- Never paste secret values here. -->
