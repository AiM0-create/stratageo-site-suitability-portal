# StrataGeo — Site Suitability Intelligence Portal

**Screens large geographies, identifies high-potential micro-markets and investigation zones, explains the spatial evidence behind each result, and shows where detailed commercial and parcel-level validation should begin.**

> **Live portal:** [aim0-create.github.io/stratageo-site-suitability-portal](https://aim0-create.github.io/stratageo-site-suitability-portal/)

**Current version: v1.12.0 — Mapbox GL JS**

> One prompt → one plan → one click. Results lead with the
> verdict, a plain-English reason, and what to do next; every technical
> diagnostic is one click away behind "Technical diagnostics".

---

## What It Does

Tell it something like *"Find top 5 dark kitchen locations near Ballygunge Phari but outside 1 km of any metro"* or *"Find a premium riverside restaurant strictly between Howrah Bridge and Vidyasagar Setu"*. The portal holds a short consultative conversation to frame the problem, then runs a full spatial **screening** and returns:

- **Priority investigation zones** — a ranked, evidence-backed shortlist of the strongest zones, each with a restrained screening verdict (Priority / Promising / Conditional / Low priority / Withheld), the evidence-backed reasons it stands out, its key risk, and the concrete next-stage validation it needs
- **Per-factor scores** with the evidence behind them (OSM / Google Places / ORS), including whether each factor was observed, observed-as-zero, or provider-unavailable
- **Hard constraints enforced** — waterfront corridors, exclusions, route constraints — as real pass/fail gates, with a per-constraint verification status (verified / proxy / not verifiable / failed)
- **Screening-stage vs detailed-validation staging** — rent, floor area, availability, zoning and ownership requirements are disclosed and converted into next-validation actions, never claimed as satisfied
- **One headline confidence verdict** — the conservative merge of data sufficiency and the reliability critic, with disagreement explained
- **An interactive map** — per-factor suitability heatmaps, AOI boundary, investigation-zone centroids (never "exact sites"), reweight-provisional pins
- **PDF export** — client-ready screening report with basemap figure, verdict strip, constraint-status table, per-zone next validation, and a clear path to a detailed site study

The product journey: **broad geography → spatial screening → priority investigation zones → detailed site/parcel validation → field and commercial due diligence.** The portal delivers the first three stages; [contact Stratageo](https://stratageo.in/contact.php) to commission the rest.

---

## What's New

The current release is **v1.12.0 — Mapbox GL JS**: the map is now GPU-rendered vector
tiles instead of raster tiles, so the suitability grid recolours instantly and pan/zoom
is smooth. All five basemaps are preserved and the PDF figure uses the same style. The
map token is served by the engine at runtime rather than compiled into the bundle.

Every release — what changed, why, and the live failure that motivated it — is in
[`CHANGELOG.md`](CHANGELOG.md). This README describes the portal as it is **today**;
it deliberately does not accumulate a section per version.

---

## The Three Layers of Intelligence

1. **The conversation — _"what should we measure?"_** A consultative LLM agent understands the brief, picks the business archetype, derives factor weights, runs a feasibility check, and proposes a methodology you can review and adjust.
2. **The engine — _"measure it precisely."_** A deterministic Python engine builds the H3 grid, gathers OSM + Places data, scores every cell, computes real ORS routes, enforces hard spatial gates, and applies buildability masks. No LLM touches the scoring math.
3. **The critic — _"do I believe this answer?"_** After ranking, a senior-consultant review audits the computed result. Active in `balanced`/`high` cost mode; disclosed in result JSON and UI either way.

---

## How Scoring Works

0. **PlannerLite (v1.4.9)** — before any expensive stage runs, a deterministic relevance gate (`engine/planner_lite.py`) decides which of water/buildability/routing/Places-refinement checks actually matter for *this* prompt. A plain cafe or supermarket brief skips buildability and water-geometry fetches entirely; a riverside brief runs the full stack. Skipped-because-irrelevant is never a failure or a degradation — it's a recorded resource decision, surfaced as `analysisCompleteness` in the result and a preview on the spec card before you click Start.
1. **Study area & grid** — The area is resolved to real localities (or a bounding polygon) and tiled with H3 hexagonal cells (res 9, ~0.1 km² each).
2. **Data gathering** — OSM Overpass (batched union query) + Google Places (New, with legacy Places/OSM fallback) per factor. Consumer POI layers auto-merged with ~40 m spatial dedup.
3. **Spatial masks** — Water mask, buildability masks (railway, ghat, heritage, maidan), waterfront corridor enforcement, exclusion buffers. Applied before scoring, and skipped by PlannerLite when not relevant to the prompt.
4. **Pass A scoring** — Every cell scored on each factor (BallTree Euclidean counts), normalized percentile-based, combined by weight.
5. **Pass B refinement** — Top-K candidates re-scored with real ORS isochrones and Google Places Aggregate counts; optional traffic-aware drive catchments.
6. **Route constraints** — Real Google Routes / ORS network routing per top-K candidate (only when relevant — see PlannerLite); railway-crossing detection.
7. **Multi-score output** — relativeRankScore, absoluteViabilityScore, confidenceScore computed; recommendation status derived from all three + critic + analysis completeness.
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
        │  POST /api/v2/chat │  Consultant LLM (gpt-5.4-mini) → SpecV2 │
        ├──────────────────► │  RawIntent parser (deterministic)        │
        │                   │  Archetype registry                       │
        │  POST /api/v2/analyses                                        │
        ├──────────────────► │  Engine:                                 │
        │   poll status      │    H3 grid · OSM + Places fetch          │
        │                   │    Spatial masks · Pass A (Euclidean)     │
        │                   │    Pass B (ORS isochrones) · Route gates  │
        │                   │    Uploaded-candidates gate               │
        │                   │    Multi-score (rank/viability/confidence)│
        │                   │    Critic pass (gpt-5.4, if cost≥balanced)│
        │ ◄─────────────────┤  ranked candidate zones + evidence        │
                            └─────────────────────────────────────────┘

  Data:   OpenStreetMap (Overpass) · Google Places (New + legacy) · Places Aggregate
          · OpenRouteService · Google Routes
  Auth:   Firebase Auth + Firestore
  Cache:  Google Cloud Storage (job snapshots)

  PlannerLite (v1.4.9) sits in front of the engine's water/buildability/routing/
  Places-refinement stages, skipping whichever are irrelevant to the prompt.
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite 6 — static SPA on GitHub Pages; Mapbox GL JS maps, Recharts |
| Backend | Python 3.12 + FastAPI on **Google Cloud Run** (`--max-instances 1 --no-cpu-throttling`) |
| Spatial | H3 (`h3-py`), Shapely, scikit-learn BallTree, NumPy |
| Data | OpenStreetMap (Overpass), Google Places (New + legacy fallback), Google Places Aggregate, OpenRouteService, Google Routes |
| LLM | OpenAI gpt-5.4-mini (conversation) · gpt-5.4-nano (explanations) · gpt-5.4 (critic) — all configurable via env vars |
| Auth | Firebase Auth + Firestore |
| Security | Secret Manager for API keys · per-IP + global rate limiting · `X-App-Token` kill-switch |
| CI | pytest (737 backend tests) · Vitest (141 frontend tests) · GitHub Actions → GitHub Pages deploy |

---

## Environment Variables

**Frontend** (Vite build-time vars; set as GitHub Actions secrets for the Pages deploy):

```
VITE_PY_BACKEND_URL           # Cloud Run engine base URL
VITE_APP_TOKEN                # X-App-Token kill-switch (ships in bundle by design)
# NOTE: there is deliberately NO Mapbox token here. Baking it in put the token
# in the shipped JS and GitHub push protection blocked every deploy. The map
# fetches it at runtime from the engine's /api/v2/map-config instead.
```

**Backend** (set in Secret Manager for Cloud Run; `.env` for local dev):

```
OPENAI_API_KEY
GOOGLE_PLACES_API_KEY
ORS_API_KEY
APP_SHARED_TOKEN
MAPBOX_TOKEN                  # Mapbox GL JS PUBLIC token (pk.). Served to the browser
                              # by /api/v2/map-config, never bundled. Rotate here alone —
                              # no frontend rebuild. A secret (sk.) token is refused.

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

# Google provider layer (v1.4.8) — all analysis-critical flags default ON and
# self-disable/fall back to legacy Places or OSM if the specific API isn't
# enabled on GOOGLE_PLACES_API_KEY's project (verify in the GCP console —
# Places API New, Places Aggregate/Area Insights, and Routes API are each
# enabled independently of a valid key existing).
ENABLE_GOOGLE_PLACES_NEW            # default: true
ENABLE_GOOGLE_PLACES_AGGREGATE      # default: true
ENABLE_GOOGLE_PLACE_DETAILS_NEW     # default: true
ENABLE_GOOGLE_ROUTES_VALIDATION     # default: true
ENABLE_GOOGLE_PLACE_PHOTOS          # default: false (UI-only, never scored)
ENABLE_GOOGLE_AUTOCOMPLETE          # default: false (frontend UX only)
ENABLE_GOOGLE_SEARCH_ALONG_ROUTE    # default: false
ENABLE_GOOGLE_AI_SUMMARIES          # default: false (narrative only, never scored)
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
npx tsc --noEmit   # typecheck
npm run build      # also runs tsc as part of the build
npm test           # vitest
```

---

## Deployment

### Backend — Google Cloud Run

```bash
gcloud run deploy stratageo-engine \
  --source backend-py/ \
  --region asia-south1 \
  --project <your-gcp-project>
# --max-instances / --no-cpu-throttling / concurrency are already set on the
# service and are NOT passed on redeploys — a bare `gcloud run deploy` with
# --source preserves the existing service configuration. Secrets are already
# set in Secret Manager — no --set-secrets needed on updates.
```

After deploy, verify:

```bash
curl https://<your-cloud-run-url>/health
```

Expected response includes `appVersion: "1.6.2"`, `engineVersion` (the actual live Cloud Run revision, read from the `K_REVISION` env var Cloud Run injects automatically — not a hardcoded string), `releaseName`, `costMode`, `featureFlags`, `hasGooglePlacesKey`/`hasGoogleRoutesKey`/`hasOrsKey`/`hasOpenAiKey` (booleans only, never the key values), and active model names.

**Rollback discipline:** before every backend deploy, tag the currently-live commit first — `git tag -a rollback-pre-vX.Y.Z <live-commit-sha> -m "..." && git push origin rollback-pre-vX.Y.Z` — so `git checkout` back to a known-good state is always one command away (see [Rollback](#rollback) below).

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

Every deploy since v1.4.2 is preceded by a `rollback-pre-vX.Y.Z` tag pointing at the commit that was actually live at the moment of tagging (not necessarily the tip of `master`):

```bash
git tag -l "rollback-pre-*"          # list available rollback points
git checkout rollback-pre-v1.4.9 -- backend-py/   # or check out the whole tree
# Redeploy backend from the checked-out state:
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project <your-gcp-project>
# Frontend: push the rolled-back commit to master to trigger the GitHub Pages workflow.
```

Do not roll back unless production is actually broken — a slow or degraded provider is handled gracefully by design (see `analysisCompleteness` / `providerDiagnostics`) and is not, by itself, a reason to revert.

---

## Version History

Recent releases only — the complete history with full rationale lives in
[`CHANGELOG.md`](CHANGELOG.md).

| Version | Summary |
|---|---|
| **v1.11.5** *(current, frontend)* | Drawer Layout Fix — a v1.11.1 flexbox regression made the results panel shrink its children instead of scrolling, squashing the Technical diagnostics / Assumptions / Evidence Trail expanders into invisible hairlines; fixed with `flex-shrink: 0` and a stylesheet regression test |
| **v1.11.4** | Editable Factors — fixes a weight editor that collapsed every other factor to 0% on a single edit; weights become sliders, direction becomes a click-to-flip toggle, factors can be removed, and new factors can be added through the planner |
| **v1.11.3** | Coastline & Quiet Detail — open-sea mask derived from `natural=coastline` (the ocean has no polygon in OSM, so coastal runs were returning offshore zones), applied at the same >30% area threshold with fail-safe behaviour everywhere; per-zone technical readouts and the duplicate confidence banner moved into collapsed "Score details" sections |
| **v1.11.2** | Plain Language — chat replies are conversational prose instead of Constraint/Factor tables that duplicated the plan card; "▶ Start analysis" became a quiet "Run analysis" outline button; sidebar drivers render as labelled bars rather than prose score-lists; the screening caveat is stated once instead of three times |
| **v1.11.1** | Answer-First Sidebar — ranked zones now render immediately after the verdict instead of after ~10 collapsed diagnostic panels; map↔card click interactivity surfaced with a caption (the capability already existed, just undiscoverable); pure CSS-order reorder, no JSX relocated |
| **v1.11.0** | Exclusion Integrity — named/coordinate exclusions were silently dropped by a schema-drift bug (SpecV2 never declared `namedExclusions`); fixed and declared, plus a regression test that fails the build if the planner ever writes an undeclared spec key again; exclusion masking now uses the place's real geocoded extent instead of a fixed circle; enforcement status promoted to a first-class result field |

---

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — every release, most recent first
- [`docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md`](docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md) — critical architecture/performance audit that motivated PlannerLite (v1.4.9); a good starting point for understanding why the pipeline is shaped the way it is
- [`docs/STRATAGEO_V1_4_KNOWN_LIMITATIONS.md`](docs/STRATAGEO_V1_4_KNOWN_LIMITATIONS.md)
- [`docs/analysis-engine-v1.5-change-log.md`](docs/analysis-engine-v1.5-change-log.md) — living per-change engine log (v1.5.0 onward): what changed, why, risk, rollback
- [`docs/archive/`](docs/archive/) — historical version-specific documents (v0.8.x–v1.4.x release notes, deployment checklists, smoke tests, phase audits), kept for the audit trail

---

## Product Disclosure

Results are **screening-level candidate zones** (H3 micro-market hexagons), never exact parcels, and the following are explicitly detected and shown as **unverified — not scored** rather than silently omitted: rent/lease price, floor area/footprint, parcel/space availability, zoning/licensing, ownership/title. Drive-time and walk-time constraints are only ever shown as verified when a real routing provider (Google Routes or ORS) computed them — never a straight-line/Euclidean substitute presented as confirmed.

---

## License

Proprietary. All rights reserved.
