# 05 — Data Providers and Missing-Data Semantics

Environment-variable **names only** below — no secret values. In production
these come from **Secret Manager** on Cloud Run (`--set-secrets`); locally from
`backend-py/.env` (which takes precedence over process env — see
`config.Settings.settings_customise_sources`).

## Provider matrix

### OpenAI

- **Purpose:** conversational planning; per-candidate explanations; optional
  critic. **Never** scoring.
- **Client:** `openai` SDK via `services/llm.py`, `results.write_explanations`,
  `services/critic.py`.
- **Auth / env:** `OPENAI_API_KEY`. Model routing via `STRATAGEO_*_MODEL`
  (defaults gpt-5.4-mini/nano/critic gpt-5.4).
- **Cost:** the dominant LLM cost; `cost_mode` (low/balanced/high) controls
  call count. Low = one planning call + template explanations + no LLM critic.
- **Timeout/retry:** SDK defaults; typed errors mapped in `chat.py`.
- **Fallback:** `stratageo_enable_model_fallback` (off) → gpt-4o/4o-mini.
- **Success/zero/unavailable:** N/A (not a data provider).
- **New MVP need:** **Yes — central.** The new portal is LLM-led planning.

### OpenStreetMap / Overpass

- **Purpose:** primary POI + geometry source (all layers, water, land-cover,
  railway, roads).
- **Client:** `engine/data_osm.py` (`fetch_all_layers` union query,
  `fetch_area_geometries`, `fetch_line_geometries`, `fetch_named_features`);
  mirror failover.
- **Auth / env:** none (public Overpass mirrors).
- **Cost:** free; rate/etiquette limited — concurrency capped (2), timeouts
  (`main_fetch_timeout=120`, `buildability_overpass_timeout=30`).
- **Timeout/retry:** per-call `asyncio.wait_for`; on failure the layer
  degrades to zero-with-note.
- **Fallback:** for consumer layers, Google Places back-up merge.
- **Success:** ≥0 features returned from a completed query.
  **Observed zero:** completed query, empty result → `observed_zero`.
  **Unavailable:** timeout/error → `unavailable`.
- **New MVP need:** **Yes — the backbone.**

### Google Places (New)

- **Purpose:** consumer POI corroboration (competitors, footfall) where OSM is
  sparse.
- **Client:** `providers/google_places_new.py` (`fetch_pois_with_fallback`):
  Text/Nearby Search New → legacy Nearby (`data_places.py`) → OSM-only.
- **Auth / env:** `GOOGLE_PLACES_API_KEY`.
- **Cost:** paid + tiled; `PLACES_FETCH_CAP=6` per job; per-job
  `ProviderBudget` + circuit breaker (`providers/base.py`).
- **Timeout/retry:** `_degradable_call` wrapper (per-call ceiling, retries on
  fast failures, breaker after 3 family failures).
- **Fallback:** legacy Places → OSM supplement.
- **Success/zero/unavailable:** `_pp_src == "none"` (all providers failed) →
  `unavailable`; empty merge → `observed_zero`.
- **New MVP need:** **Yes** (competition/footfall corroboration).

### Google Places Aggregate

- **Purpose:** authoritative place *count* (computeInsights) within a circle ≈
  catchment, refining top-candidate counts.
- **Client:** `providers/google_places_aggregate.py` (`compute_count`).
- **Auth / env:** `GOOGLE_PLACES_API_KEY`; gated by
  `enable_google_places_aggregate`.
- **Cost:** paid; capped at 8 candidates × google layers per job.
- **Success/zero/unavailable:** `status ∈ {ok, disabled, degraded}`; on
  disabled/degraded the existing counts are kept.
- **New MVP need:** **Later** (refinement nicety, not core).

### Google Routes

- **Purpose:** traffic-aware drive catchments; strict route-time gates.
- **Client:** `providers/google_routes.py`, `engine/traffic.py`,
  `route_policy.py`. Uses the **same key** as Places.
- **Auth / env:** `GOOGLE_PLACES_API_KEY` (Routes shares it; health reports
  `hasGoogleRoutesKey = hasPlacesKey`).
- **Cost:** paid; one call per candidate per traffic layer (~≤12×layers),
  circuit-broken after 3 failures.
- **Success/zero/unavailable:** reachable-count or congestion ratio; failure →
  free-flow proxy kept **with an honest label** ("FREE-FLOW estimate").
- **New MVP need:** **Later** (traffic realism) — but the free-flow honesty
  label is a keeper idea.

### OpenRouteService (ORS)

- **Purpose:** true walk/drive isochrones (Pass B); network route directions.
- **Client:** `engine/catchments.fetch_isochrones`, `engine/routing.py`.
- **Auth / env:** `ORS_API_KEY`.
- **Cost:** free tier, rate-limited; `ors_batch_size=5`,
  `optional_provider_timeout=45`.
- **Success/zero/unavailable:** isochrone polygon or `{}`; failure → Euclidean
  proxy kept with note.
- **New MVP need:** **Yes** for real catchments (or substitute a routing
  provider). Note: currently ORS may be unset in some deployments → Euclidean
  fallback.

### Geocoding / reverse geocoding

- **Purpose:** study-area resolution + candidate naming.
- **Client:** `engine/study_area.py` (`geocode` Google→Nominatim fallback;
  `reverse_geocode_name`). Country/state-level matches are **rejected** (guards
  the "analyzed the centroid of India" failure).
- **Auth / env:** `GOOGLE_PLACES_API_KEY` (Google geocoding); Nominatim public.
- **New MVP need:** **Yes.**

### Basemap tiles

- **Purpose:** map + PDF figure backdrop.
- **Client:** Leaflet (`MapView.tsx`, `config.basemaps`) + `mapFigure.ts`
  (Carto `light_all` raster tiles, CORS-enabled, attributed).
- **Auth / env:** none.
- **New MVP need:** **Yes** for the map (PDF later).

### Firebase (auth + Firestore)

- **Purpose:** Google/email sign-in, per-user quota, saved/shared analyses,
  admin analytics.
- **Client:** `config/firebase.ts`, `services/analysisStore.ts`,
  `usageTracker.ts`, backend `auth_quota.py`.
- **Auth / env:** frontend Firebase config (public, in-bundle); backend
  verifies Firebase ID tokens; `firestore.rules`.
- **New MVP need:** **Likely NOT.** Reasons to not copy: it couples identity,
  quota, saved-analysis compatibility, and admin into the core; the new MVP can
  ship with a simpler auth (or none) and add persistence later. Documented here
  only to justify *excluding* it.

### GCS / storage-cache

- **Purpose:** cross-restart job snapshots (`services/storage.py`).
- **Status:** wired but **disabled** (`hasGcsBucket:false`).
- **New MVP need:** **No** (in-memory job store is fine for MVP;
  see `08`/`10`).

## Environment-variable names (backend)

`OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `ORS_API_KEY`, `APP_SHARED_TOKEN`,
`FRONTEND_ORIGINS`, `STRATAGEO_CHAT_MODEL`, `STRATAGEO_REASONING_MODEL`,
`STRATAGEO_CRITIC_MODEL`, `STRATAGEO_REPORT_MODEL`, `STRATAGEO_FAST_MODEL`,
`STRATAGEO_MAX_LLM_COST_MODE`, `STRATAGEO_DETERMINISTIC_PLANNING`,
`STRATAGEO_ENABLE_MODEL_ESCALATION`, `STRATAGEO_ENABLE_MODEL_FALLBACK`,
`REQUIRE_USER_AUTH`, `MAX_PROMPTS_PER_USER`, `QUOTA_ADMIN_EMAILS`,
`CHAT_TURNS_PER_HOUR`, plus engine-tuning vars (`MAX_HEXES`, `REFINE_TOP_K`,
`JOB_MAX_RUNTIME_SECONDS`, timeouts). `K_REVISION` is injected by Cloud Run.

## Environment-variable names (frontend, build-time via Vite)

`VITE_APP_MODE`, `VITE_AI_BACKEND_URL` (vestigial Vercel Node API),
`VITE_PY_BACKEND_URL` (Cloud Run — the live path), `VITE_CONVERSATIONAL_MODE`,
`VITE_APP_TOKEN` (rotatable kill-switch, ships in bundle). Firebase config is
inlined in `config/firebase.ts`.

## Missing-data semantics recap (the load-bearing distinction)

**Observed zero ≠ unavailable.** A successful query that finds no competitors
is a real observation (the market may genuinely be uncontested — validate
locally); a provider failure is *unknown*. The current code encodes this in
`LayerScores.data_status` and never converts either into an ideal score. The
new portal **must preserve this three-state distinction end to end** — it is
the difference between an honest screening tool and one that fabricates
whitespace.
