# Stratageo — Site Suitability Portal

**Spatial intelligence for smarter site selection.**

Stratageo brings GIS-grade location analysis to businesses, developers, and consultants — without requiring GIS expertise. You describe what you want to build and where, in plain language, and the portal screens the whole area on a fine spatial grid, scores every candidate location against the factors that matter, enforces your hard constraints, and returns a ranked shortlist with the evidence behind each score — then **reviews its own answer** like a senior location consultant before you ever see it.

> **Try it live:** [aim0-create.github.io/stratageo-site-suitability-portal](https://aim0-create.github.io/stratageo-site-suitability-portal/)

**Current version: v1.0.2**

---

## What It Does

Tell it something like *"a dark kitchen in South Kolkata within a 10-minute delivery drive of Ballygunge Phari, but outside 1 km of any metro"* or *"a premium cafe in Bengaluru near offices, low competition"*. The portal holds a short consultative conversation to frame the problem, then runs a full spatial analysis and returns:

- **A ranked shortlist** of the strongest locations, each named and explained
- **Per-factor scores** with the real evidence behind them (what was observed, from which source, precise vs. proxy)
- **Hard constraints enforced** — "within X minutes of Y", "outside Z" — as real pass/fail gates, not soft penalties
- **Real network routing** — drive/walk times on the actual road network, typical traffic, railway-crossing checks
- **An interactive map** — per-factor suitability heatmaps (greener = better) and travel-time catchments
- **An automatic "Analyst Review"** — a senior-consultant audit of the result (geographic sanity, meaningful factors, data strength, rule compliance) with a Reliable / Weak / Unreliable verdict

## The Three Layers of Intelligence

The portal is best understood as three cooperating minds:

1. **The conversation — _"what should we measure?"_** A consultative LLM agent understands the brief, picks the business archetype, derives factor weights, identifies proxies, runs a feasibility check, and proposes a transparent methodology you can review and adjust.
2. **The engine — _"measure it precisely."_** A deterministic Python engine builds the grid, gathers real-world data, scores every cell, computes real routes, and enforces hard rules. No LLM touches the scoring math.
3. **The critic — _"do I believe this answer?"_** After ranking, a senior-consultant review audits the computed result against the brief and grades it. This is what turns a smart-sounding tool into a trustworthy one.

## How Scoring Works

Scoring uses **Multi-Criteria Decision Analysis (MCDA)** on an **H3 hexagonal grid**, in two passes:

1. **Study area & grid** — The area is resolved to real localities (or a point-radius) and tiled with thousands of H3 hex cells.
2. **Data gathering** — For each factor, features are pulled from **OpenStreetMap (Overpass)** and **Google Places**.
3. **Pass A — full-grid proxy scoring** — Every cell is scored on each factor (Euclidean catchment counts), normalized, and combined by weight into a composite. Weights are renormalized **preserving ratios** — never clamped.
4. **Pass B — refinement of top candidates** — The strongest candidates are re-scored with true **OpenRouteService isochrones**, and for destination businesses, **traffic-aware drive catchments** via the Google Routes API.
5. **Constraints & exclusions** — Network **route constraints** (real ORS Directions, with railway-crossing detection) and **hard exclusion buffers** remove disqualified cells from contention — computed, not fabricated.
6. **Ranking & explanation** — Surviving sites are ranked; the top few are named and explained with per-factor evidence.

**Honesty is enforced, not optional:**

- A factor with **no data** is marked *insufficient data* and excluded from the composite — never silently scored 0 or 10.
- A factor that **does not differentiate** the shortlisted sites is flagged and scored neutral, so a meaningless number can't dominate the result.
- A requirement is a **pass/fail constraint**, never re-encoded as a weighted scoring factor — so a site that *meets* a constraint can't be contradicted by a 0/10 on the same thing.
- If a required constraint can't be evaluated, the ranking is **withheld** with an honest explanation rather than inventing a winner.

## Architecture

```
                          ┌──────────────────────────────────────────┐
  React + Vite SPA        │  Conversational FastAPI Engine (Cloud Run) │
  (GitHub Pages)          │                                            │
        │  POST /api/v2/chat                                           │
        ├───────────────► │  Consultant LLM (gpt-4o) ─► SpecV2 (method) │
        │                 │     archetype playbook · feasibility gate   │
        │  POST /api/v2/analyses (job)                                 │
        ├───────────────► │  Engine:                                    │
        │   poll status   │    H3 grid ─► OSM + Google Places fetch      │
        │                 │    Pass A (Euclidean) ─► Pass B (ORS iso)    │
        │                 │    route constraints (ORS) · traffic (Routes)│
        │                 │    exclusion masks · data-aware scoring      │
        │                 │       │                                      │
        │                 │       ▼                                      │
        │                 │  Critic pass (gpt-4o) ─► Analyst Review       │
        │ ◄───────────────┤  ranked sites + evidence + map layers        │
                          └──────────────────────────────────────────┘

  Data: OpenStreetMap (Overpass) · Google Places · OpenRouteService · Google Routes
  Persistence/cache: Google Cloud Storage   Auth: Firebase   Legacy fallback: Vercel /api/analyze
```

**Key principle:** AI handles language and judgment (framing the method, reviewing the result); the analytical core that produces scores is deterministic and auditable.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite 6 — static SPA on GitHub Pages; Leaflet maps, Recharts.
- **Backend:** Python 3 + FastAPI conversational engine on **Google Cloud Run** (`--max-instances 1 --no-cpu-throttling`); job-based async analysis with GCS-persisted snapshots and caches.
- **Spatial core:** H3 (`h3-py`), Shapely, scikit-learn BallTree, NumPy.
- **Data:** OpenStreetMap (Overpass), Google Places (Nearby Search), OpenRouteService (isochrones + directions), Google Routes (traffic-aware matrix).
- **AI:** OpenAI **gpt-4o** (conversation, spec extraction, critic) and **gpt-4o-mini** (result explanations).
- **Auth & data:** Firebase Auth + Firestore (admin allowlist, append-only usage log).
- **Security:** API keys in Secret Manager; per-IP + global rate limiting; request-size caps; rotatable `X-App-Token` kill-switch.
- **CI:** automated backend test suite (pytest) and GitHub Actions deploy to Pages.

## Versioning

| Version | Highlights |
|---------|------------|
| **v1.0.2** _(current)_ | Post-execution **self-critique / Analyst Review**; discrimination-aware scoring; constraints no longer double-encoded as scoring factors; hard-exclusion + tight study-area handling; per-factor data-quality reporting |
| **v1.0.1** | Conversational FastAPI engine on Cloud Run; H3 two-pass MCDA; **network routing** (ORS Directions + railway-crossing); **traffic-aware** drive catchments; data-aware scoring (no fabricated 0/10); feasibility-first gate; archetype playbook; security hardening |
| **v1.0.0** | Move from single-shot neighborhood scoring to a structured SpecV2 methodology contract |
| **v0.5.0** | Profile-aware MCDA, NCR support, named exclusions, feasibility validation, Hindi/Hinglish input _(legacy single-shot path, still available as a Vercel fallback)_ |

## Roadmap

- **Richer demand data** — true population / building-density signals so "demand" is a real gradient where OSM is sparse
- **Self-correcting analysis** — let the Analyst Review auto-rerun once with its own suggested fix when it judges a result unreliable
- Custom criteria/weights UI and saved workspaces
- Multi-area comparative reports and branded PDF export

## Known Limitations

- OpenStreetMap coverage varies by region — sparsely mapped areas can depress or flatten scores independently of real-world suitability (the Analyst Review flags this when it happens).
- Scoring reflects *relative* suitability from available spatial signals, not an absolute investment recommendation.
- Network routing and traffic depend on third-party services (ORS, Google); when unavailable the engine falls back to calibrated proxies and says so.

## License

Proprietary. All rights reserved.
