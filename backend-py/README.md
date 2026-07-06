# Stratageo Analysis Engine

See the root [`README.md`](../README.md) for the current version, architecture
diagram, and full environment-variable reference — this file covers backend-
specific local dev / deploy notes only.

Conversational, spec-driven site-suitability backend. Replaces the single-shot
"prompt → immediate execution" flow with:

1. **`POST /api/v2/chat`** — multi-turn conversation with the configured chat
   model (`STRATAGEO_CHAT_MODEL`, default gpt-5.4-mini). The model acts
   as a methodology consultant: clarifies goals, builds a structured `SpecV2`
   (layers, weights, catchments, H3 grid, study area), honestly flags anything
   the engine can't do, and only sets `readyToExecute` on an explicit user go
   signal. It never executes anything itself.
2. **`POST /api/v2/analyses`** — validates the spec and starts a background job.
   Returns `{jobId}`.
3. **`GET /api/v2/analyses/{jobId}`** — poll for progress
   (`status/progress/phase/message`) and the final result, which matches the
   frontend's `AnalysisResult` shape exactly (ResultsDrawer/MapView render it
   unchanged).

## Engine design

- **H3 hex grid** (res 7–10, default 9; auto-degrades above 8000 hexes).
- **One Overpass union query** for all OSM layers + exclusions, classified
  client-side into layers.
- **Two-pass scoring**: Pass A scores every hex with Euclidean proxy radii
  (walk = 80 m/min, drive = 400 m/min); Pass B re-scores the top ~25 spatially
  deduplicated candidates with true OpenRouteService isochrones, re-using
  Pass A normalization so values stay comparable. No ORS key → graceful proxy
  fallback, disclosed in the methodology string.
- **Weights are renormalized preserving ratios — never clamped.** (The v1.0.0
  Node pipeline flattened 25/17/10/8 to equal weights via a per-layer clamp;
  the regression test `tests/p1_chat_test.py` guards against this.)
- **Custom-layer sandbox** (`SANDBOX_ENABLED=true`, default off): LLM-written
  `compute(hexes, pois)` snippets run in an AST-validated, isolated subprocess
  (`-I -S`, cleared env, 15 s timeout, rlimits on Linux, no network/files).

## Local dev (Windows)

```powershell
cd backend-py
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env   # fill in keys
uvicorn app.main:app --reload --port 8000
```

Frontend `.env.local`:

```
VITE_PY_BACKEND_URL=http://localhost:8000
VITE_CONVERSATIONAL_MODE=1
```

Note: `app/config.py` gives `.env` precedence over process env vars, so a stale
user-level `OPENAI_API_KEY` on the machine cannot shadow the project key.

## Tests

```powershell
# live LLM regression test (server must be running):
python tests\p1_chat_test.py
```

## Deploy — Cloud Run

```bash
gcloud run deploy stratageo-engine --source backend-py --region asia-south1 \
  --allow-unauthenticated --memory 1Gi --cpu 1 --timeout 900 \
  --min-instances 0 --max-instances 1 --no-cpu-throttling \
  --set-env-vars FRONTEND_ORIGINS=https://aim0-create.github.io,SANDBOX_ENABLED=false \
  --set-secrets OPENAI_API_KEY=openai-key:latest,GOOGLE_PLACES_API_KEY=places-key:latest,ORS_API_KEY=ors-key:latest
```

`--max-instances 1` and `--no-cpu-throttling` are **load-bearing**: the job
store is in-process memory and the worker thread must keep CPU between polls.

Render alternative: create a Web Service from `backend-py/Dockerfile`, set the
env vars in the dashboard. Free tier spins down (~30–60 s cold start on the
first chat turn).

## Env vars

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | chat + result explanations (see `STRATAGEO_*_MODEL` vars in the root README for which model does what) |
| `GOOGLE_PLACES_API_KEY` | geocoding + google_places layers |
| `ORS_API_KEY` | OpenRouteService isochrones (free signup: openrouteservice.org) |
| `FRONTEND_ORIGINS` | comma-separated CORS allowlist |
| `SANDBOX_ENABLED` | custom-layer snippets (default false) |
| `STRATAGEO_CHAT_MODEL` | default `gpt-5.4-mini` (legacy alias: `CHAT_MODEL`) |
