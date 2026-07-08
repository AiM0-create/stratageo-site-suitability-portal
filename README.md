# StrataGeo — Site Suitability Intelligence Portal

**Conversational site-suitability intelligence portal for India with deterministic spatial safeguards, MCDA scoring, confidence disclosure, and report export.**

> **Live portal:** [aim0-create.github.io/stratageo-site-suitability-portal](https://aim0-create.github.io/stratageo-site-suitability-portal/)

**Current version: v1.6.7 — Report Map & Weight-Responsive Grid Ranks**

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

## v1.6.7 Highlights

- **The PDF report now contains the map** — a self-rendered analytical figure (H3 surface, AOI boundary, numbered ranked pins, legend, scale bar) drawn entirely from the analysis data; grey when the recommendation is withheld, custom weights disclosed in the caption. Each ranked zone gets an "Open in Google Maps" link for field validation.
- **Every eligible grid cell is ranked** — hover any cell for "rank X of N eligible cells", recomputed live as you move weight sliders.
- **Top-X selection responds to weights** — sliders re-select the best zones from the whole re-weighted grid (dashed amber pins + list), explicitly labeled screening-basis/unverified with a bold routing caveat; original verified candidates keep their green pins.
- **Refined scores say they're relative** (v1.6.5) — "0.0" with 934 observed features now explains it's the lowest *among the shortlist* (with the observed range); near-identical values no longer stretch to 0-vs-10; real OSM/Google counts are no longer mislabeled "AI-generated".
- **Shortfall notes name the actual filter** (v1.6.6) — e.g. the required travel-time route check, with the failed count.

---

## v1.6.4 Highlights

- **A pick's map colour now matches its card score** — each chosen candidate's hex cell is recoloured with its FINAL refined score (tooltip: "FINAL refined score (chosen candidate)"); all other cells keep the comparable screening surface, and the report's ranking-basis note explains the distinction.
- **The map can no longer contradict a withheld recommendation** — when a result is flagged unreliable, the hex surface renders neutral grey with context-only tooltips instead of confident green/red gradation.
- **Coordinates in prompts are honored verbatim** — "Chinar Park[22.62, 88.43]"-style places are parsed deterministically from the raw prompt (even if the AI strips them from the spec) and never sent to a text geocoder; country/state-level geocode matches are rejected outright, closing the failure class where a brief silently analyzed the centroid of India.
- **Candidate shortfall is explained** — fewer surviving zones than requested now comes with a note saying how many survived and why.

---

## v1.6.3 Highlights

- **The analysis grid default coarsened from H3 resolution 9 (~0.10 km² hexes) to resolution 8 (~0.74 km² hexes)** — fewer cells per study area means faster runs with more provider-stage headroom, at neighbourhood (rather than street) granularity.
- **The plan card now offers a grid-level choice**: Level 7 (~5.2 km² hexes — district-scale screening, fastest) or Level 8 (~0.74 km² — neighbourhood-scale, default). The choice is preserved across chat turns exactly like the v1.6.0 weight sliders, and an explicit choice wins over the prompt-wording block-granularity override.
- Auto-degrade is unchanged: a study area that would exceed the hex budget still drops one level with a recorded note.

---

## v1.6.2 Highlights

- **Fixed a live-observed correctness bug**: "high-end gym in Mumbai" (a bare screening prompt with zero water/land-development wording) put a candidate on the coastline/dockyard edge and another near Mumbai Port Trust/CSMT railway land.
- **Buildability relevance is now a single source of truth** — the planner's "should this stage even run?" gate previously used a narrower, independently-drifting check than the one that actually picks which no-build masks to apply, so most commercial briefs ("gym", "cafe", "supermarket", …) silently lost their railway/ghat/protected-land protection. The two are now the same function; they can't diverge again.
- **Water relevance is geography-aware, not just prompt-text-aware** — a resolved coastal/port metro (Mumbai, Chennai, Kolkata, Kochi, Visakhapatnam, and other major Indian coastal cities) now triggers the water mask even when the prompt itself says nothing about water.
- **No timeout regression** — both fixes make the buildability stage run more often, but each run is still bounded by the existing v1.5.2 stage budget + concurrency + per-fetch degradation, which caps worst-case wall clock independent of how often the stage fires (pinned by a new regression test).

---

## v1.6.1 Highlights

- **One confidence verdict, not three** — `unifiedConfidence` merges data sufficiency and the reliability critic into a single High/Medium/Low headline banner, conservative-by-design (the overall level is the worst of the components) with a reason sentence that explains any disagreement instead of hiding it.
- **Customer-facing PDF upgrades** — the exported report now includes the Overall Confidence verdict and a Factor Weight Audit table (playbook default vs. applied weight per factor), headed "ADJUSTED BY USER" whenever the customer moved a slider.
- **Payment-grade per-customer quotas** — each account can now have its own admin-granted allotment (`maxPrompts`) instead of one hardcoded cap, enforced in three independent places: the backend engine transactionally (where the cost is incurred), Firestore rules (a user can neither create nor raise their own allotment), and the UI ("N of 5 queries left"). Admin Dashboard gained **Set allotment** / **Reset usage** per user.
- **Server-side identity + quota enforcement** (`backend-py/app/auth_quota.py`) — Firebase ID tokens verified on `/api/v2/chat` and `/api/v2/analyses`; fails **closed** if verification infrastructure is unavailable. Ships **OFF** by default (`STRATAGEO_REQUIRE_USER_AUTH=false`) for rollout safety — flipping it on is a deliberate go-live action, see [`docs/PHASE3-SECURITY-REVIEW.md`](docs/PHASE3-SECURITY-REVIEW.md).
- **Chat rate limiting** — a per-user sliding-window cap (60 turns/hour default) on the free-to-use chat endpoint, closing a gap where a signed-in user could loop the LLM endpoint without ever starting a paid analysis.

---

## v1.6.0 Highlights

- **Factor weight sliders, fully wired** — the plan-card and results-drawer weight sliders now go end to end. Adjust a weight on the plan card before running: the adjustment is flagged and **preserved** by the deterministic planner across chat turns (previously, typing "run" after adjusting silently reset the weights to archetype defaults — a real bug, now fixed with a regression test).
- **Instant post-run re-ranking and map recoloring** — moving a slider in the "⚖ Factor weights" panel re-ranks the candidate list **and** recolors the hex-grid map immediately, client-side, with zero re-fetch and zero analysis-credit cost.
- **Honesty banner on adjusted rankings** — an amber "Custom weights active" banner appears whenever sliders differ from defaults, explaining that confidence/stability labels and the shortlist itself were computed under default weights — re-run to discover different zones under the new weights.
- **Weight audit trail** — every analysis now records a `weightAudit` (default archetype weights vs. executed weights, and whether the customer adjusted them), so an adjusted ranking is never presented as the untouched default methodology.
- **Fixed a real scoring bug** — the existing (unfinished) slider recompute treated a factor with no data as a fabricated zero in the weighted mean instead of excluding it — unfairly dragging down candidates in data-sparse areas. Fixed to match the backend's honesty rules, with a regression test proving an 8/10-only-factor candidate now scores 8.0, not 5.6.

---

## v1.5.2 Highlights

- **No more buildability timeouts** — the up-to-6 land-exclusion Overpass fetches (railway / ghat / heritage / maidan / road-frontage) now run **concurrently (2 at a time, Overpass mirror etiquette) under a single 90-second stage budget**. Any fetch that can't fit degrades honestly ("skipped — confidence reduced") instead of blowing the 240-second job ceiling — the failure observed live on 2 of 4 canonical test prompts is fixed and re-verified live.
- **Deterministic stage planning** — an LLM-attached water exclusion with no water signal in the actual prompt can no longer flip the water/buildability stage plan between runs of the identical prompt. Stage relevance is now decided only by the user's words, the waterfront flag, or a real water corridor.
- **Deterministic objective** — the analysis objective shown on the plan card is template-generated from parsed inputs (top-N, business type, study area), so the identical prompt produces a byte-identical objective every run; waterfront cues are still detected from the user's raw words.
- **Right playbook for small-format grocery** — "small / organic / kirana / convenience / neighbourhood" grocery briefs now get the neighbourhood-retail factor set (walk footfall, co-tenancy, competition, transit; res-9 grid) instead of the hypermarket playbook. "Massive discount supermarket" still correctly gets large-format.
- **Block-scale grids on request** — prompts asking for "specific intersections or blocks" get an H3 res-10 grid (~66 m cells), driven purely by the user's own words.
- **Screening vs refined score transparency** — the map colors cells by the fast screening score; final ranking uses refined (isochrone/routing/Places-verified) scores. Every candidate now carries both, and the card shows "map/screening 7.2 → refined 6.4" whenever they meaningfully differ.

---

## v1.5.1 Highlights

- **Hard Constraint Verification panel** — every requested hard constraint now gets an explicit status in the results drawer: **Verified / Proxy verified / Not verifiable from available data / Requested but not enforced / Failed / Not required**, with counts, reasons, and per-candidate warning chips for anything unresolved.
- Rent / floor-area / zoning / parcel / ownership constraints are always *Not verifiable* (field validation required); an unresolved metro exclusion or unavailable routing shows *Requested but not enforced* — never silently kept.
- A safety cap guarantees an unresolved requested hard constraint can never coexist with the strongest "Recommended Investigation Zone" verdict.
- Pure visibility layer over state the pipeline already computed — zero new provider calls, zero scoring changes.

---

## v1.5.0 Highlights

- **Analysis Intelligence Lite** — a deterministic classification of every analysis, computed at plan time with zero new provider calls: `businessArchetype` (food_footfall / delivery_kitchen / large_format_retail / hospitality_destination / healthcare / education / logistics / generic), `locationIntent`, `riskTriggers` (waterfront, rent cap, large floorplate, strict boundary, …), and `analysisMode`.
- **Scenario ranking stability** — the final shortlist is re-ranked under four controlled weighting scenarios (balanced / demand-led / access-led / competition-sensitive); each candidate is labeled *Robust top candidate*, *Stable top 3*, *Scenario sensitive*, or *Weak/unstable*, with the sensitive scenario named. Pure local math on already-computed scores.
- **Granular data sufficiency (`dataSufficiencyV2`)** — geocoding, boundary/corridor, demand, competition, road access, routing, and buildability each labeled verified / proxy / unknown / degraded / not-required, plus hard-constraint verified/unknown/failed counts and a human-readable confidence reason.
- **Honest investigation-zone labels** — analyses and candidates now carry *Recommended Investigation Zone / Provisional Candidate / Weak Candidate / No Reliable Recommendation / No Viable Site in Constraints*. A strong recommendation is only possible when nothing critical is unverified **and** the rank survives the stability check; unknown rent/floorplate constraints show **"Field validation required"**.
- All of it surfaced in the results drawer: analysis-level verdict badge, per-candidate labels, data-sufficiency panel — additive UI, old payloads render exactly as before.
- **Zero new external calls** — every v1.5 addition is local arithmetic over data the pipeline already fetched.

---

## v1.4.9 Highlights

- **PlannerLite** (`engine/planner_lite.py`) — a minimal, deterministic per-prompt relevance gate. Before the engine runs, it decides which expensive stages actually matter for *this* prompt instead of running the same generic checklist every time.
- **Irrelevant buildability/water/maidan/heritage/railway checks are skipped** for prompts with no waterfront, land-development, or railway-avoidance signal (a plain cafe or supermarket brief no longer pays for the same checks a riverside restaurant needs).
- **Routing only runs when it's actually relevant** — an explicit route constraint or detected drive/walk-time phrasing in the prompt; skipped for generic cafe/retail briefs that never asked for it.
- **Unsupported constraints** (rent, floor area/footprint, zoning, parcel availability, ownership) are labeled **"unverified — not scored"** up front, before the analysis even runs, not just after.
- **`analysisCompleteness`** added to the result payload — what was verified, what was skipped (a resource decision, never a failure), what degraded, and the resulting confidence level (H/M/L) and provisional status.
- **Result contract unchanged**: every analysis still ends in exactly one of `SUCCESS` / `NO_VIABLE_SITE` / `FAILED` — skipped-because-irrelevant stages never turn into a failure; a degraded *relevant* stage marks the result provisional instead.
- **No new APIs, no engine rewrite** — this is a YAGNI resource-optimization release on top of the v1.4.8 provider layer, not a new architecture.

---

## v1.4.8 Highlights

- **Google Places API (New) provider layer** — Nearby Search / Text Search (New) as the primary POI source, with the legacy Nearby Search API and OSM/Overpass retained as automatic fallback if the New API is unavailable or errors.
- **Places Aggregate (Area Insights) for density/count intelligence** — authoritative POI counts refine the top shortlisted candidates' competition/co-tenancy/amenity scores. Self-disables and falls back to Places/OSM-derived counts if the Aggregate API is not enabled, out of quota, or lacks permission on the current key/project — never blocks an analysis.
- **Google Routes as the primary route validator**, ORS Directions retained as fallback; a route constraint that can't be computed by either provider is marked **unavailable/provisional**, never silently replaced by straight-line distance.
- **Typed provider contract** (`ProviderResult`) for every external call: strict timeout, bounded retry with backoff only for retryable errors, per-provider circuit breaker, per-job Google budget, and per-job caching — a slow or failing provider degrades gracefully with a visible note instead of crashing the analysis.
- **Result contract unchanged and enforced**: every analysis still ends in exactly one of `SUCCESS` / `NO_VIABLE_SITE` / `FAILED`, now with `providerDiagnostics` (including per-call Google provider status) attached to the payload.
- Place Details (New) enrich a capped set of top evidence POIs (rating, review count, price level) — evidence only, never used in MCDA scoring.

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
| Frontend | React 19, TypeScript, Vite 6 — static SPA on GitHub Pages; Leaflet maps, Recharts |
| Backend | Python 3.12 + FastAPI on **Google Cloud Run** (`--max-instances 1 --no-cpu-throttling`) |
| Spatial | H3 (`h3-py`), Shapely, scikit-learn BallTree, NumPy |
| Data | OpenStreetMap (Overpass), Google Places (New + legacy fallback), Google Places Aggregate, OpenRouteService, Google Routes |
| LLM | OpenAI gpt-5.4-mini (conversation) · gpt-5.4-nano (explanations) · gpt-5.4 (critic) — all configurable via env vars |
| Auth | Firebase Auth + Firestore |
| Security | Secret Manager for API keys · per-IP + global rate limiting · `X-App-Token` kill-switch |
| CI | pytest (608 backend tests) · Vitest (75 frontend tests) · GitHub Actions → GitHub Pages deploy |

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

Full detail for every release lives in [`CHANGELOG.md`](CHANGELOG.md); this is a compact index. See the "Highlights" sections above for v1.4.8/v1.4.9 detail.

| Version | Highlights |
|---|---|
| **v1.6.7** *(current)* | Report Map & Weight-Responsive Grid Ranks — self-rendered map figure in the PDF, Google Maps links per zone, live grid ranks on hover, weight-sliders re-select a screening-basis top-X (explicitly unverified), relative-score transparency + spread-aware refit, shortfall notes name the responsible filter |
| **v1.6.4** | Map Coherence & Coordinate Fidelity — candidate cells recoloured with final refined scores, grey context-only surface when the recommendation is withheld, prompt coordinates used verbatim + country-level geocode matches rejected, candidate-shortfall notes |
| **v1.6.3** | H3 Grid-Level Choice — default grid coarsened from res 9 to res 8; plan-card picker for Level 7 (district-scale) vs Level 8 (neighbourhood-scale), preserved across chat turns like the weight sliders |
| **v1.6.2** *(backend-only)* | Smart Water/Buildability Relevance — fixed a live bug where commercial briefs could land on port/rail/water land; buildability relevance now shares one source of truth with mask selection, water relevance is geography-aware (coastal metros), no timeout regression |
| **v1.6.1** | Confidence, Report & Quotas — unified confidence verdict, PDF weight-audit table, per-customer admin-granted quota allotments, server-side auth/quota enforcement (off by default), chat rate limiting |
| **v1.6.0** | Factor Weight Sliders — plan-card weight adjustments preserved across chat turns (fixes a silent-wipe bug), post-run sliders re-rank + instantly recolor the map client-side, weight audit trail (default vs. executed), fixed a fabricated-zero scoring bug in the reweighting engine |
| **v1.5.2** | Reliability & Consistency — buildability stage budget + concurrent fetches (fixes live 240s timeouts), deterministic stage planning & templated objective (identical prompt → identical plan), small-format grocery archetype fix, block-scale res-10 grids on request, screening→refined score transparency |
| **v1.5.1** | Hard Constraint Verification Visibility — per-requested-constraint status panel (Verified / Proxy verified / Not verifiable / Requested but not enforced / Failed), per-candidate warning chips, strong-verdict safety cap |
| **v1.5.0** | Analysis Intelligence Lite — deterministic archetype/intent/risk classification, scenario ranking stability, granular `dataSufficiencyV2`, investigation-zone label taxonomy, all surfaced in the UI; zero new provider calls |
| **v1.4.9** | PlannerLite smart resource gating — skips irrelevant water/buildability/routing/Places-refinement stages per prompt; `analysisCompleteness` payload; unsupported constraints labeled up front |
| **v1.4.8** | Google Places API (New) provider layer, Places Aggregate count refinement, Google Routes primary route validator — legacy Places/OSM/ORS retained as fallback throughout |
| **v1.4.1–1.4.7** | Execution-flow reliability, per-provider timeout/degradation, results-crash safety, numeric scoring contract (`engine/contracts.py`), three-state result payload (`success`/`no_viable_site`/`failed`) |
| **v1.4.0** | Reliability Hardening: constraint policy engine, always-on deterministic critic, verified metro station resolver, score display policy (displayScore/scoreBand/confidenceLabel), data coverage accounting |
| **v1.3.0** | Evidence Trail & Reproducible Site Selection Reports — full `EvidenceTrail` schema, provider query tracking, `/evidence` endpoint |
| **v1.2.0** | Deterministic planning: canonical archetype schemas, frozen factor weights, spec fingerprinting, no-reliable-recommendation handling, relaxation options |
| **v1.1.2** | Hotfix: restore `_is_water_tag` import — NameError crashed analysis for non-waterfront briefs |
| **v1.1.1** | Cost-aware model routing refresh: gpt-5.4-mini / gpt-5.4-nano / gpt-5.4 · max_completion_tokens for gpt-5.x compat |
| **v1.1.0** | Universal archetype registry · RawIntent parser · multi-dimensional scoring · uploaded-candidates-only enforcement · cost-aware model routing · honest R/V/C score labels |
| **v1.0.3** | Spatial Reliability Upgrade: waterfront corridor enforcement · buildability masks · viability gate · competition-whitespace capping · raw-candidate UI gating |
| **v1.0.2** | Post-execution self-critique / Analyst Review; discrimination-aware scoring; constraints no longer double-encoded |
| **v1.0.1** | Conversational FastAPI engine on Cloud Run; H3 two-pass MCDA; network routing (ORS); traffic-aware drive catchments |
| **v1.0.0** | SpecV2 methodology contract; structured analysis |

---

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md) — every release, most recent first
- [`docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md`](docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md) — critical architecture/performance audit that motivated PlannerLite (v1.4.9); a good starting point for understanding why the pipeline is shaped the way it is
- [`docs/STRATAGEO_V1_4_KNOWN_LIMITATIONS.md`](docs/STRATAGEO_V1_4_KNOWN_LIMITATIONS.md)
- `docs/` contains 30+ additional release-note, deployment-checklist, and phase-audit files from earlier versions (v1.0.x–v1.3.x) — browse the directory for full history

---

## Product Disclosure

Results are **screening-level candidate zones** (H3 micro-market hexagons), never exact parcels, and the following are explicitly detected and shown as **unverified — not scored** rather than silently omitted: rent/lease price, floor area/footprint, parcel/space availability, zoning/licensing, ownership/title. Drive-time and walk-time constraints are only ever shown as verified when a real routing provider (Google Routes or ORS) computed them — never a straight-line/Euclidean substitute presented as confirmed.

---

## License

Proprietary. All rights reserved.
