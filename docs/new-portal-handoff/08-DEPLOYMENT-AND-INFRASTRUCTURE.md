# 08 — Deployment and Infrastructure

## Current deployment architecture

| Concern | Current setup |
|---------|---------------|
| GitHub repo | `AiM0-create/stratageo-site-suitability-portal`, default branch **master** |
| Frontend host | **GitHub Pages** (`aim0-create.github.io/stratageo-site-suitability-portal/`), served from the `gh-pages` branch |
| Frontend CI | `.github/workflows/deploy-pages.yml` — on push to `master`: `npm ci` → `npm run build` (live env vars) → `peaceiris/actions-gh-pages@v4` to `gh-pages`. Concurrency group `pages`, cancel-in-progress |
| Backend host | **Google Cloud Run** service `stratageo-engine`, region **asia-south1**, project **stratageo-location-intel-prod**, account **stratageo2024@gmail.com** |
| Backend deploy | `gcloud run deploy stratageo-engine --source backend-py --region asia-south1` (source deploy; Cloud Buildpacks) |
| Cloud Run config | **`--max-instances 1 --no-cpu-throttling`** (load-bearing: in-memory job store + worker threads; must not be "optimized" away). Concurrency default |
| Backend CI | `.github/workflows/backend-tests.yml` runs pytest; deploy is manual `gcloud` |
| Secrets | **Secret Manager** on Cloud Run: `openai-api-key`, `google-places-api-key`, `ors-api-key` (`:latest`) via `--set-secrets`; compute SA `1020081478981-compute@developer.gserviceaccount.com` has `secretAccessor`. `APP_SHARED_TOKEN` as env var |
| Firebase | project `stratageo-location-intel-prod`; Auth + Firestore; `firestore.rules` (admin-grant-only quota) |
| CORS | backend `FRONTEND_ORIGINS`; headers `Content-Type, X-App-Token, Authorization` |
| App token | `VITE_APP_TOKEN` (GH secret) must equal `APP_SHARED_TOKEN` (Cloud Run); rotate together |
| DNS/domain | none custom (github.io + run.app + stratageo.in marketing site) |
| Health verify | `GET /health` → `appVersion` + `engineVersion` (= `K_REVISION`) |
| Rollback | annotated tags `rollback-pre-vX.Y.Z` at the **live-verified** commit; redeploy from tag or Cloud Run traffic-split |
| Deploy order | **backend first** (deploy + verify `/health`), **then** push `master` (Pages) |

Legacy: a Vercel project (`stratageo-site-suitability-portal`) still serves the
old Node `/api/analyze` single-shot path; `VITE_AI_BACKEND_URL` points at it but
the live app runs conversational mode against Cloud Run. It is effectively
orphaned.

## New-portal deployment implications

The new portal has **entirely new infrastructure and no inherited state**.
Recommended minimum independent setup:

| Component | Recommendation | Why |
|-----------|----------------|-----|
| GitHub repo | New private repo | Clean history; no inherited patches |
| Frontend host | **Vercel** (new project) | The brief names Vercel; SPA + preview deploys + env-var UI are simpler than the GH Pages + `peaceiris` dance; no `gh-pages` branch to manage |
| Backend host | **Cloud Run** (new service) | **Keep Cloud Run.** The backend is Python + geospatial (h3-py, Shapely, scikit-learn, numpy, ORS/Overpass I/O). Vercel/Lambda serverless is a poor fit for heavy geospatial deps and the long-running (up to 240 s) threaded job model. Cloud Run source-deploy already handles the buildpack |
| Backend region | Pick nearest to users (asia-south1 for India) | Latency to Overpass/Google |
| Job model | Start with in-memory + `--max-instances 1 --no-cpu-throttling` | Matches current; avoids a queue/DB for MVP. Revisit if you need multi-instance |
| Secrets | New Secret Manager entries (new keys) | Do not reuse old keys/tokens |
| Env vars | New `OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `ORS_API_KEY`, `FRONTEND_ORIGINS`, model routing, `APP_SHARED_TOKEN`; frontend `VITE_*` | Fresh, no legacy aliases |
| CORS | New allowlist = the Vercel domain(s) | |
| App token | Keep the rotatable `X-App-Token` kill-switch pattern | Cheap abuse guard for a public demo |
| CI/CD | Vercel auto-deploy on push (frontend); GitHub Action or manual `gcloud` for backend | |
| Logs | Cloud Run logs (backend) + Vercel logs (frontend); separate | |
| Provider-cost tracking | New Google Cloud billing project | Isolate spend from the old portal |
| Auth | **Optional for MVP.** If needed, a lighter option than Firebase (e.g. Vercel-friendly auth) — see `10` for why not to copy Firebase | Reduces coupling |

### Recommended stack, stated plainly

> **Vercel frontend + Cloud Run backend.**

Reasons: the frontend is a static React SPA that Vercel serves ideally with
zero custom CI; the backend is a heavy, long-running Python geospatial service
that Cloud Run (container, no request-duration cap issue with the right config,
buildpack for native deps) fits far better than any serverless-function host.
This splits cleanly, tracks cost separately, and drops the GH Pages + Vercel
Node-API + `gh-pages`-branch complexity the current portal carries.

**Do not** default the new frontend to GitHub Pages just because the old one
uses it — Vercel is simpler for a new project and matches the brief.

## Deployment guardrails to carry forward (proven the hard way)

- **Backend before frontend**, always verify `/health` (`appVersion` +
  `engineVersion` = revision) before pushing the frontend.
- **Rollback tag at the commit that is ACTUALLY live** (verified via
  `/health`), not at git tip.
- **Never change `--max-instances`/concurrency** without re-checking the
  in-memory job-store assumption.
- **Rotate `X-App-Token` on both sides together** or the live portal 401s.
- **No deploy from a dirty tree.**

*(This task performs none of the above — it is documentation only.)*
