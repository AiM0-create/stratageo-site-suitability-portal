# StrataGeo — Site Suitability Intelligence Portal

**Conversational site-suitability intelligence portal for India with deterministic spatial safeguards, MCDA scoring, confidence disclosure, and report export.**

> **Live portal:** [aim0-create.github.io/stratageo-site-suitability-portal](https://aim0-create.github.io/stratageo-site-suitability-portal/)

**Current version: v1.1.2 — Water Tag Helper NameError Fix**

---

## What It Does

Tell it something like *"Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro"* or *"Find a premium riverside restaurant strictly between Howrah Bridge and Vidyasagar Setu"*. The portal holds a short consultative conversation to frame the problem, then runs a full spatial analysis and returns:

- **A ranked shortlist** of the strongest candidate zones, each named and explained
- **Per-factor scores** with the evidence behind them (OSM / Google Places / ORS)
- **Hard constraints enforced** — waterfront corridors, exclusions, route constraints — as real pass/fail gates
- **Multi-dimensional scores** — relative rank, absolute viability, and confidence — not a single opaque composite
- **Critic enabled/disabled disclosure** — the post-execution self-critique runs in `balanced`/`high` cost mode; its status is always visible
- **Uploaded-candidates-only gate** — if you say "only rank my uploaded points", the engine restricts to those points and blocks if none are provided
- **An interactive map** — per-factor suitability heatmaps, AOI boundary, raw/withheld markers
- **PDF export** — screening-level report with version, disclaimer, and recommendation mode disclosure

---

## v1.1.0 Highlights

| Feature | Details |
|---|---|
| **Deterministic RawIntent parser** | Extracts output count, business type, hard constraints, and spatial relations from the raw prompt before the LLM. Hard constraints that can't be traced to a SpecV2 gate surface as advisory warnings. |
| **Output count inference** | Default 3; user-specifiable 1–10; capped at 10 with warning if >10 requested. Chat UI no longer shows a result-count dropdown. |
| **Universal archetype registry** | 14 archetypes (QSR, premium restaurant, dark kitchen, clinic, maternity clinic, hospital, preschool, gym, retail, warehouse, EV charger, hotel, office, industrial, generic). Each has factor weights, scoring curves, and misleading-variable warnings. |
| **Multi-dimensional scoring** | `relativeRankScore` + `absoluteViabilityScore` + `confidenceScore` alongside the composite. Recommendation labels: RECOMMENDED / CANDIDATE_ZONE / WEAK_CANDIDATE / RAW_DIAGNOSTIC / EXCLUDED. |
| **Cost-aware model routing** | All model names configurable via env vars (see below). Default = `low` (cost-sensitive). Operator opt-in for `balanced` (critic enabled). No GPT-5.x hardcoded. |
| **Uploaded-candidates-only enforcement** | "Only rank my uploaded CSV points" is a HARD GATE. Engine either scores only those points or blocks with a clear message. No H3 grid fallback. |
| **Honest UI/PDF** | No "final site" or "exact site" wording. ResultsDrawer shows R/V/C scores, recommendation status, critic enabled/disabled, constraint enforcement level, and candidate source. |
| **Contradictory constraint detection** | "Within 500 m of metro AND outside 2 km of metro" is detected and surfaced before execution. |

---

## The Three Layers of Intelligence

1. **The conversation — _"what should we measure?"_** A consultative LLM agent understands the brief, picks the business archetype, derives factor weights, runs a feasibility check, and proposes a methodology you can review and adjust.
2. **The engine — _"measure it precisely."_** A deterministic Python engine builds the H3 grid, gathers OSM + Places data, scores every cell, computes real ORS routes, enforces hard spatial gates, and applies buildability masks. No LLM touches the scoring math.
3. **The critic — _"do I believe this answer?"_** After ranking, a senior-consultant review audits the computed result. Active in `balanced`/`high` cost mode; disclosed in result JSON and UI either way.

---

## How Scoring Works

1. **Study area & grid** — The area is resolved to real localities (or a bounding polygon) and tiled with H3 hexagonal cells (res 9, ~0.1 km² each).
2. **Data gathering** — OSM Overpass (batched union query) + Google Places per factor. Consumer POI layers auto-merged with ~40 m spatial dedup.
3. **Spatial masks** — Water mask, buildability masks (railway, ghat, heritage, maidan), waterfront corridor enforcement, exclusion buffers. Applied before scoring.
4. **Pass A scoring** — Every cell scored on each factor (BallTree Euclidean counts), normalized percentile-based, combined by weight.
5. **Pass B refinement** — Top-K candidates re-scored with real ORS isochrones; optional traffic-aware drive catchments.
6. **Route constraints** — Real ORS network routing per top-K candidate; railway-crossing detection.
7. **Multi-score output** — relativeRankScore, absoluteViabilityScore, confidenceScore computed; recommendation status derived from all three + critic.
8. **Viability gate** — Candidates below minimum viable score withheld; waterfront/strict briefs may return `insufficient_viable_land`.

**Honesty enforced by design:**
- Missing data → excluded from composite, never silently scored 0 or 10.
- Non-discriminating factor → neutral 0.5, flagged.
- Hard constraint with no data → ranking withheld.
- Uploaded-points-only request with no points → blocked (no H3 fallback).

---

## Architecture

```
  React + Vite SPA          ┌─────────────────────────────────────────┐
  (GitHub Pages)            │  FastAPI Engine  (Google Cloud Run)      │
        │                   │                                           │
        │  POST /api/v2/chat │  Consultant LLM (gpt-4o) → SpecV2       │
        ├──────────────────► │  RawIntent parser (deterministic)        │
        │                   │  Archetype registry                       │
        │  POST /api/v2/analyses                                        │
        ├──────────────────► │  Engine:                                 │
        │   poll status      │    H3 grid · OSM + Places fetch          │
        │                   │    Spatial masks · Pass A (Euclidean)     │
        │                   │    Pass B (ORS isochrones) · Route gates  │
        │                   │    Uploaded-candidates gate               │
        │                   │    Multi-score (rank/viability/confidence)│
        │                   │    Critic pass (gpt-4o, if cost≥balanced) │
        │ ◄─────────────────┤  ranked candidate zones + evidence        │
                            └─────────────────────────────────────────┘

  Data:   OpenStreetMap (Overpass) · Google Places · OpenRouteService · Google Routes
  Auth:   Firebase Auth + Firestore
  Cache:  Google Cloud Storage (job snapshots)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite 6 — static SPA on GitHub Pages; Leaflet maps, Recharts |
| Backend | Python 3.12 + FastAPI on **Google Cloud Run** (`--max-instances 1 --no-cpu-throttling`) |
| Spatial | H3 (`h3-py`), Shapely, scikit-learn BallTree, NumPy |
| Data | OpenStreetMap (Overpass), Google Places (New), OpenRouteService, Google Routes |
| LLM | OpenAI gpt-5.4-mini (conversation) · gpt-5.4-nano (explanations) · gpt-5.4 (critic) — all configurable via env vars |
| Auth | Firebase Auth + Firestore |
| Security | Secret Manager for API keys · per-IP + global rate limiting · `X-App-Token` kill-switch |
| CI | pytest (236 tests) · GitHub Actions → GitHub Pages deploy |

---

## Environment Variables

**Backend** (set in Secret Manager for Cloud Run; `.env` for local dev):

```
OPENAI_API_KEY
GOOGLE_PLACES_API_KEY
ORS_API_KEY
APP_SHARED_TOKEN

# Cost-aware model routing (v1.1.0)
STRATAGEO_CHAT_MODEL          # default: gpt-5.4-mini
STRATAGEO_REASONING_MODEL     # default: gpt-5.4-mini
STRATAGEO_CRITIC_MODEL        # default: gpt-5.4
STRATAGEO_REPORT_MODEL        # default: gpt-5.4-nano
STRATAGEO_FAST_MODEL          # default: gpt-5.4-nano
STRATAGEO_MAX_LLM_COST_MODE   # default: low  (low | balanced | high)
STRATAGEO_ENABLE_MODEL_ESCALATION  # default: false

# Legacy aliases (still honoured for backward compat)
CHAT_MODEL
EXPLAIN_MODEL
CRITIC_MODEL
```

**Frontend** (Vite build-time, baked into bundle):

```
VITE_PY_BACKEND_URL    # Cloud Run service URL
VITE_APP_TOKEN         # X-App-Token sent with every backend request
VITE_DEMO_MODE         # "true" for offline demo mode
```

---

## Cost Mode

| Mode | What it does |
|---|---|
| `low` *(default)* | Deterministic-first; single LLM call; concise explanations; critic disabled. Ideal for cost-sensitive or high-volume operation. |
| `balanced` | One critic call per analysis; better executive summary. **Recommended for client-grade reports where post-execution reviewer audit is desired.** |
| `high` | Optional escalation enabled (if configured); richer reports; critic always on. |

Set via `STRATAGEO_MAX_LLM_COST_MODE` in your environment. The `/health` endpoint always shows the active cost mode.

---

## Local Development

### Backend

```bash
cd backend-py/
python -m venv .venv
# Windows:  .venv\Scripts\activate
# Unix/Mac: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # fill in API keys
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
npm install
cp .env.example .env.local   # set VITE_PY_BACKEND_URL=http://localhost:8000
npm run dev
```

### Tests

```bash
# Backend (from backend-py/)
pytest tests/ -v

# Frontend
npm run typecheck
npm run build
```

---

## Deployment

### Backend — Google Cloud Run

```bash
cd backend-py/
gcloud run deploy stratageo-engine \
  --source . \
  --region asia-south1 \
  --max-instances 1 \
  --no-cpu-throttling \
  --project <your-gcp-project>
# Secrets are already set in Secret Manager — no --set-secrets needed on updates.
```

After deploy, verify:

```bash
curl https://<your-cloud-run-url>/health
```

Expected response includes `appVersion: "1.1.0"`, `engineVersion: "1.1.0"`, `costMode`, `featureFlags`, and active model names.

### Frontend — GitHub Pages

Frontend deploys automatically via GitHub Actions on every push to `master`. No manual step required.

---

## Limitations & Disclaimer

> **Outputs are preliminary suitability screening, not legal, parcel, lease, rent, ownership, zoning, or field due diligence.**

- OSM coverage varies by region — sparsely mapped areas can depress or flatten scores.
- Scoring reflects relative suitability from available spatial signals, not an absolute investment recommendation.
- Network routing depends on OpenRouteService; when unavailable the engine falls back to calibrated proxies and says so.
- Hard constraints from the `outside_distance` and `within_distance` class require the LLM to build the correct SpecV2 gates — advisory warnings are shown if a constraint cannot be traced.
- Results describe candidate zones / micro-market areas, not exact parcels or sites.

---

## Rollback

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# Redeploy backend and rebuild frontend from the checked-out state.
```

---

## Version History

| Version | Highlights |
|---|---|
| **v1.1.2** *(current)* | Hotfix: restore `_is_water_tag` import in `jobs.py` — NameError crashed any analysis with corridor water-tag checks (e.g. QSR near EM Bypass) |
| **v1.1.1** | Cost-aware model routing refresh: gpt-5.4-mini / gpt-5.4-nano / gpt-5.4 · max_completion_tokens for gpt-5.x compat |
| **v1.1.0** | Universal archetype registry · RawIntent parser · multi-dimensional scoring · uploaded-candidates-only enforcement · cost-aware model routing · honest R/V/C score labels |
| **v1.0.3** | Spatial Reliability Upgrade: waterfront corridor enforcement · buildability masks · viability gate · competition-whitespace capping · raw-candidate UI gating |
| **v1.0.2** | Post-execution self-critique / Analyst Review; discrimination-aware scoring; constraints no longer double-encoded |
| **v1.0.1** | Conversational FastAPI engine on Cloud Run; H3 two-pass MCDA; network routing (ORS); traffic-aware drive catchments |
| **v1.0.0** | SpecV2 methodology contract; structured analysis |

---

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/RELEASE_NOTES_v1.1.0.md`](docs/RELEASE_NOTES_v1.1.0.md)
- [`docs/DEPLOYMENT_CHECKLIST_v1.1.0.md`](docs/DEPLOYMENT_CHECKLIST_v1.1.0.md)
- [`docs/FINAL_PR_SUMMARY_v1.1.0.md`](docs/FINAL_PR_SUMMARY_v1.1.0.md)
- [`docs/PHASE_18_UPLOADED_POINTS_ONLY_FIX.md`](docs/PHASE_18_UPLOADED_POINTS_ONLY_FIX.md)
- [`docs/PHASE_17_SMOKE_TEST_v1.1.0.md`](docs/PHASE_17_SMOKE_TEST_v1.1.0.md)

---

## License

Proprietary. All rights reserved.
