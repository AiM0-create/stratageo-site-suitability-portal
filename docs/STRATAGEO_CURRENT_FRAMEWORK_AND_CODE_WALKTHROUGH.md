# Stratageo Site Suitability Portal — Full Technical Walkthrough

> **Generated:** 2026-06-29 · **Version documented:** v1.3.0 (master branch, revision stratageo-engine-00046)  
> **Purpose:** Reference document for external AI/developer review. Factual only — no guesses. All gaps flagged explicitly.

---

## 1. Executive Summary

Stratageo is an AI-assisted **site suitability intelligence portal** for India. A user types a natural-language business brief ("Find top 3 locations for a quick-service cafe targeting students near Ruby Crossing and the EM Bypass"). The portal:

1. Interprets the brief through a conversational LLM consultant that extracts business type, geography, hard constraints, and scoring factors.
2. Proposes an analysis framework (factor weights, methodology, feasibility check) for the user to approve.
3. Executes a deterministic spatial analysis pipeline: geocoding → H3 hex grid → OSM/Google Places data fetch → MCDA scoring → spatial masks (water, railway, buildability) → optional isochrone refinement → candidate ranking → critique.
4. Returns ranked candidate zones on a map with per-factor scores, evidence trail, confidence flags, and honest caveats.

**What it is NOT:** It does not find exact parcels, verify rent, confirm building availability, or execute any financial transactions. All outputs are **screening-level candidate zones**, not investment recommendations.

---

## 2. Repository Structure

```
stratageo-site-suitability-portal/
├── backend-py/                        Python FastAPI backend (Cloud Run)
│   ├── app/
│   │   ├── main.py                    FastAPI app factory; mounts middleware + routers
│   │   ├── config.py                  Settings (Pydantic), version constants, model routing
│   │   ├── security.py                SecurityMiddleware: body-size cap, X-App-Token gate, rate limiting
│   │   ├── models/
│   │   │   ├── spec.py                SpecV2 Pydantic model — the analysis contract
│   │   │   ├── chat.py                ChatRequest/ChatResponse; validate_spec()
│   │   │   └── evidence.py            EvidenceTrail schema (v1.3.0)
│   │   ├── routers/
│   │   │   ├── chat.py                POST /api/v2/chat
│   │   │   ├── analyses.py            POST /api/v2/analyses; GET /api/v2/analyses/{id}; /evidence
│   │   │   └── health.py              GET /health
│   │   ├── services/
│   │   │   ├── llm.py                 chat_turn() — LLM consultant, deterministic planner
│   │   │   ├── jobs.py                _run_analysis() — full spatial pipeline orchestrator
│   │   │   ├── prompts.py             chat_system_prompt() — 500-line system prompt
│   │   │   ├── archetypes.py          ARCHETYPE_PLAYBOOK for backfill
│   │   │   ├── critic.py              critique_analysis() — post-execution self-critique
│   │   │   └── storage.py             GCS persistence (optional)
│   │   └── engine/
│   │       ├── intent_parser.py       parse_raw_intent() — deterministic pre-LLM extraction
│   │       ├── canonical_archetypes.py  10 frozen archetype schemas; to_layers_dict()
│   │       ├── deterministic_planner.py apply_deterministic_plan(); planning_fingerprint()
│   │       ├── study_area.py          geocode(); resolve_study_area() → shapely polygon
│   │       ├── grid.py                polyfill() — H3 hex grid; HexCell dataclass
│   │       ├── data_osm.py            fetch_all_layers() — batched Overpass union query
│   │       ├── data_places.py         fetch_places_pois() — Google Places Nearby Search
│   │       ├── scoring.py             pass_a(); composite_for_hex(); fit_normalization()
│   │       ├── results.py             build_location(); write_explanations(); build_hex_grid()
│   │       ├── water.py               water_mask(); water_overlap_mask()
│   │       ├── buildability.py        centroid_in_polygon_mask(); line_buffer_mask()
│   │       ├── corridors.py           distance_to_lines_m(); corridor_mask()
│   │       ├── catchments.py          fetch_isochrones() — Google Routes primary / ORS fallback
│   │       ├── routing.py             evaluate_route_constraint() — ORS Directions
│   │       ├── traffic.py             traffic_catchment() — Google Routes Matrix
│   │       ├── poi_merge.py           merge_pois() — spatial dedup of OSM + Places
│   │       ├── multi_score.py         compute_multi_scores() — R/V/C scores + recommendation status
│   │       ├── uploaded_candidates.py validate/score user-supplied CSV points
│   │       ├── evidence_builder.py    QueryTracker; assemble_evidence_trail()
│   │       └── sandbox.py             run_custom_layer() — sandboxed custom Python layers
│   └── tests/                         pytest suite (335 tests)
├── src/                               React/TypeScript frontend (GitHub Pages)
│   ├── App.tsx                        Root: state management, all handlers, PDF export
│   ├── config/index.ts                Runtime config (backend URLs, sectors, basemaps)
│   ├── config/firebase.ts             Firebase app, auth, Firestore
│   ├── types/index.ts                 All TypeScript interfaces (AnalysisResult, EvidenceTrail …)
│   ├── types/chat.ts                  SpecV2 TypeScript type
│   ├── contexts/
│   │   ├── AuthContext.tsx            Firebase auth state; consumePrompt()
│   │   └── SessionContext.tsx         Multi-session chat history + working memory
│   ├── components/
│   │   ├── FloatingAssistant.tsx      Chat UI: input, message list, copy/edit/share actions
│   │   ├── SpecSummaryCard.tsx        Analysis plan card with factor table + "▶ Start analysis"
│   │   ├── ResultsDrawer.tsx          Ranked locations, criteria chart, evidence trail
│   │   ├── MapView.tsx                Leaflet map: markers, hex grid, catchments, AOI outline
│   │   ├── GuidedTour.tsx             Step-by-step onboarding tooltip overlay
│   │   ├── TopBar.tsx                 Logo, version badge, session controls, PDF export
│   │   ├── LoginScreen.tsx            Firebase email + Google sign-in
│   │   ├── AdminDashboard.tsx         Usage analytics view (admin only)
│   │   └── SavedAnalyses.tsx          Firestore-persisted past analyses
│   └── services/
│       ├── chatService.ts             sendChatTurn(); startAnalysis(); pollAnalysis()
│       ├── analysisService.ts         runDemoAnalysis(); runServerAnalysis()
│       └── benchmarks.ts             compareToBenchmark()
├── .github/workflows/deploy-pages.yml  CI: npm build → GitHub Pages on master push
└── docs/                              Documentation (this file)
```

---

## 3. Tech Stack and Runtime

### Frontend
| Component | Technology |
|---|---|
| Framework | React 19 + TypeScript |
| Build tool | Vite 6 |
| Map library | Leaflet (CDN global `L`) |
| Charting | Recharts |
| Markdown rendering | react-markdown + remark-gfm |
| Auth + database | Firebase Auth + Firestore |
| Deployment | GitHub Pages (auto via `deploy-pages.yml`) |

### Backend
| Component | Technology |
|---|---|
| Framework | FastAPI (Python 3.13) |
| Runtime | Cloud Run, asia-south1, max-instances=1, no CPU throttling |
| Geospatial grid | h3-py v4 (H3 hexagons) |
| Geometry | Shapely 2.x |
| ML/spatial search | scikit-learn BallTree (haversine counts) |
| HTTP client | httpx (async) |
| Data validation | Pydantic v2 |
| GCS persistence | google-cloud-storage (optional; degrades gracefully) |

### AI / Model APIs
| Service | Used for | Config var |
|---|---|---|
| OpenAI gpt-5.4-mini | Conversational planning, spec generation | `STRATAGEO_CHAT_MODEL` |
| OpenAI gpt-5.4 | Post-execution critique (balanced/high cost modes) | `STRATAGEO_CRITIC_MODEL` |
| OpenAI gpt-5.4-nano | Per-candidate explanations, methodology | `STRATAGEO_REPORT_MODEL` |

### Data APIs
| API | Purpose | Config var |
|---|---|---|
| Google Places Nearby Search | Consumer POI data | `GOOGLE_PLACES_API_KEY` |
| Google Geocoding API | Study area geocoding (primary) | `GOOGLE_PLACES_API_KEY` (same key) |
| Google Routes computeRouteMatrix | Isochrone polygon building (v1.4+) | `GOOGLE_PLACES_API_KEY` |
| OpenStreetMap Overpass API | Infrastructure, land use, road, water | none (public) |
| OpenRouteService (ORS) | Isochrone polygons (fallback), route constraints | `ORS_API_KEY` |
| Nominatim | Geocoding fallback; reverse geocoding | none (public) |

### Important Environment Variables (names only — never values)
```
OPENAI_API_KEY              OpenAI API key for all LLM calls
GOOGLE_PLACES_API_KEY       Google Places + Geocoding + Routes
ORS_API_KEY                 OpenRouteService isochrones + routing
APP_SHARED_TOKEN            Rotatable kill-switch token (frontend sends as X-App-Token)
FRONTEND_ORIGINS            CORS allowed origins
GCS_BUCKET                  (optional) GCS bucket for job persistence + caches
STRATAGEO_MAX_LLM_COST_MODE "low" | "balanced" | "high" (default: low; critic off in low)
VITE_PY_BACKEND_URL         Backend URL baked into frontend build
VITE_CONVERSATIONAL_MODE    "1" enables conversational Python engine
VITE_APP_TOKEN              Shared token baked into frontend build
```

---

## 4. End-to-End User Flow

### Step 1: Portal opens
- `src/main.tsx` → renders `<App>` wrapped in `AuthProvider` + `SessionContextProvider`.
- `MapView.tsx` initialises Leaflet on a CARTO light basemap.
- `GuidedTour.tsx` auto-starts for new non-admin users (localStorage flag `sg_tour_seen_v14`).

### Step 2: Login
- `LoginScreen.tsx` shows Google OAuth + email/password forms.
- `AuthContext.tsx → buildAuthUser()` fetches or creates a Firestore user doc, reads `promptsUsed`, sets `isAdmin` flag.
- Admins: `ADMIN_EMAILS` list in `src/config/firebase.ts`. Non-admins: capped at `MAX_PROMPTS_PER_USER` (10).

### Step 3: User types a prompt
- `FloatingAssistant.tsx → handleSubmit()` calls `onRunAnalysis(text)`.
- `App.tsx → handleRunAnalysis()` detects `config.isConversationalMode` (true in production) → calls `handleChatTurn(rawPrompt)`.
- `handleChatTurn()` calls `chatService.ts → sendChatTurn(history, chatSpec, context)`.
- `chatService.ts` sends `POST /api/v2/chat` with message history and current spec draft.

### Step 4: Backend receives chat turn
**`routers/chat.py → chat()`** → calls `services/llm.py → chat_turn()`.

Inside `chat_turn()`:
1. **Spec staleness guard** (v1.4+): If the new prompt's business type differs from the spec's stored business type, the old spec is discarded.
2. **`parse_raw_intent(last_user)`** — deterministic pre-LLM extraction (see §5).
3. **LLM call** — `gpt-5.4-mini` with the full system prompt + conversation history + current spec draft at temperature=0, seed=42.
4. **Carry-forward** — if the LLM omits the spec on a short turn ("yes", "run it"), the prior spec is reused.
5. **Waterfront false-positive guard** — if the LLM set `waterfront.isWaterfront=true` but `detect_waterfront(prompt)` returns false, the flag is overridden.
6. **Deterministic planner** (`apply_deterministic_plan`) — overrides LLM's layer structure with canonical archetype schema.
7. **`_strip_empty_source_layers`** in `analyses.py` and default tags in `to_layers_dict()` prevent invalid empty-source layers.
8. **`validate_spec(new_spec)`** → sets `specValid`. If false, `chatReady` stays false and the "Start analysis" button doesn't appear.
9. **`is_go_signal(last_user)`** — regex check; if true and spec is valid, forces `readyToExecute=True`.
10. **Unvalidatable constraint downgrade** — if any constraint has `status=unvalidatable`, `feasibility.status` is forced to `tradeoffs` (not `not_feasible`).

**Frontend** receives `ChatResponse`:
- `App.tsx → setChatStage(resp.stage)`, `setChatReady(resp.readyToExecute && resp.specValid)`
- If `chatStage !== 'chat'` and `chatSpec` is present → `SpecSummaryCard` is shown.
- If `chatReady=true` → `▶ Start analysis` button appears in `SpecSummaryCard`.

### Step 5: User confirms ("yes") and runs ("run the analysis")

Two separate turns:
- **"yes"** → stage `framework`, `readyToExecute=false` — plan displayed for review.
- **"run the analysis"** → `is_go_signal()` returns true → `readyToExecute=true`, stage=`ready`.

User clicks `▶ Start analysis` in `SpecSummaryCard` → `App.tsx → handleConfirmExecute()`:
1. Calls `consumePrompt()` → increments Firestore `promptsUsed` counter.
2. Injects `userCandidatePoints` (CSV upload) + `uploadedCandidatesOnly` into spec.
3. Calls `chatService.ts → startAnalysis(spec)` → `POST /api/v2/analyses`.
4. **`analyses.py → start_analysis()`**: feasibility gate (rejects `not_feasible`), `_repair_spec_layers()`, `SpecV2.model_validate()`, `jobs.start_job(spec)`.
5. Worker thread starts in background; frontend polls `GET /api/v2/analyses/{jobId}` every ~5s.

### Step 6: Spatial analysis runs (jobs.py `_run_analysis()`)

See §6 for full pipeline. On completion, `job.result` is set with all ranked locations, hex grid, catchments, evidence trail.

### Step 7: Results rendered

Frontend detects `status=done`:
- `App.tsx` sets `result`, `locations`, opens `ResultsDrawer`.
- `MapView.tsx` renders:
  - Hex grid choropleth (green = favourable, direction-corrected)
  - Numbered candidate markers (green/grey depending on `recommendationWithheld`)
  - Study area boundary polygon
  - Isochrone catchment polygons (walk = green, drive = purple)
- `ResultsDrawer.tsx` shows ranked list, factor comparison chart, analysis assumptions, evidence trail.

---

## 5. Prompt Interpretation / AI Agent Logic

### Pre-LLM deterministic parser (`engine/intent_parser.py`)

`parse_raw_intent(prompt)` runs BEFORE the LLM. Pure regex, no network calls.

| Extraction | Method | Example |
|---|---|---|
| Output count | `_COUNT_RE` regex | "top 5" → `topNResolved=5` (capped at 10) |
| Business type | `_BIZ_PATTERNS` list (regex cascade) | "quick-service cafe" → `"cafe"` |
| Hard constraints | `_HARD_TERMS` regex on sentences | "must be on arterial" → phrase extracted |
| Spatial relations | `_SPATIAL_PATTERNS` dict | "outside 1km" → `"outside_distance"` |
| Feature classes | `_FEATURE_PATTERNS` dict | "EM Bypass" → `"highway"` |
| Geography | heuristic regex | "between X and Y", "in Sector V" |
| Uploaded-only | `_UPLOADED_ONLY_RE` | "only rank my uploaded points" → hard gate |

**Business type mapping** (`_PARSER_TO_CANONICAL` in `canonical_archetypes.py`):
- `"cafe"` + students in prompt → `student_qsr_cafe`
- `"cafe"` otherwise → `generic_qsr_cafe`
- `"restaurant"` → `generic_qsr_cafe`
- `"dark_kitchen"` → `dark_kitchen`
- `"clinic"` / `"hospital"` → `clinic_healthcare`
- `"supermarket"` / `"discount_supermarket"` → `large_format_retail`
- `"warehouse"` / `"logistics"` → `warehouse_logistics`

### LLM consultant system prompt (`services/prompts.py`)

~500-line prompt defining the consultant's operating principles. Key rules (abbreviated):

- **P1**: Assume, don't ask. Make defensible defaults; never ask clarifying questions except for genuinely impossible requests.
- **P2**: Methodology before layers. Pick the spatial analysis type before selecting factors.
- **P5**: Proxies with honest confidence. Mark weak proxies; never claim data that doesn't exist.
- **P7**: Feasibility gate. Extract hard/soft constraints; classify as `feasible|tradeoffs|not_feasible|insufficient_data`. Rent constraints are always `unvalidatable` → `tradeoffs`, never `not_feasible`.
- **P7b**: Never let absence of data become a score. Required layers with no data → withhold ranking.
- **P7c**: Never double-encode a single anchor as both a route constraint and a scoring layer.
- **P7f**: "Within X of a road/river" = `corridors` entry (true geometry gate), NOT a POI-count scoring layer.

### Staged conversation flow

| Stage | Trigger | LLM output |
|---|---|---|
| `chat` | First message | Short conversational reply, spec built invisibly |
| `framework` | User says "yes/proceed/move ahead" | Full plan: feasibility, factor table, scenarios, caveats |
| `ready` | User says "run/execute/start" OR `is_go_signal()` fires | 1-2 line confirmation; `readyToExecute=true` |

### Test prompt classification

**Prompt 1** — "quick-service cafe targeting students near Ruby crossing and EM Bypass"
- `businessTypeKey` = `"cafe"` → `detect_student_qsr()` = true → `student_qsr_cafe` archetype
- Hard constraints: `"near EM Bypass"` → corridor (`highway=primary`), not waterfront
- `isWaterfront` guard prevents false waterfront detection for the EM Bypass

**Prompt 2** — "premium riverside restaurant between Howrah Bridge and Vidyasagar Setu"
- `businessTypeKey` = `"restaurant"` → `premium_restaurant` archetype
- Waterfront: `detect_waterfront()` matches "riverside" → `isWaterfront=true`, `strictness=normal`
- `betweenLandmarks` = ["Howrah Bridge", "Vidyasagar Setu"] → AOI = convex hull + buffer

**Prompt 3** — "discount supermarket in Sector V, primary arterial road, rent ≤ ₹20/sq ft"
- `businessTypeKey` = `"discount_supermarket"` → `large_format_retail` archetype
- Arterial road → `corridors` entry (`highway=primary`)
- Rent constraint → `status="unvalidatable"` → `feasibility="tradeoffs"` (never `not_feasible`)

**Prompt 4** — "dark kitchen in South Kolkata within 10-min drive of Ballygunge Phari, outside 1km of metro"
- `businessTypeKey` = `"dark_kitchen"` → `dark_kitchen` archetype
- Route constraint: "within 10-min drive of Ballygunge Phari" → `spec.routeConstraints`
- Exclusion: "strictly outside 1km of metro" → `spec.exclusions` with `bufferM=1000`

### Deterministic planner (`engine/deterministic_planner.py`)

After the LLM builds a spec, `apply_deterministic_plan()` overrides:
- `spec.layers` → replaced with `canonical.to_layers_dict()` (locked weights, canonical factor keys)
- `spec.grid.resolution` → from archetype (res 9 for micro-market; res 8 for drive-catchment)
- `spec.output.topN` → from intent parser
- Adds `planningMode`, `planningFingerprint`, `archetypeKey`, `weightsSource="deterministic_registry"`

`planning_fingerprint()` = SHA-256 of (normalized\_prompt + archetype\_key + schema\_hash + engine\_version + cost\_mode) → stable across runs within the same engine version.

---

## 6. Spatial Analysis Pipeline

All steps are in `services/jobs.py → _run_analysis()`.

### Step 1: Study area resolution
**`engine/study_area.py → resolve_study_area(spec.studyArea)`**
- `type="places"`: geocode each place name concurrently (Google Geocoding → Nominatim fallback).
- `type="bbox"`: direct Shapely box.
- `type="point_radius"`: `Point.buffer()`.
- For "places" with ≥2 points: convex hull of geocoded points + `hullBufferM` (default 500m) buffer.

### Step 2: H3 hex grid
**`engine/grid.py → polyfill(polygon, resolution)`**
- Uses h3-py v4 `h3shape_to_cells()`.
- Auto-degrades resolution (9→8→7) if cell count exceeds `max_hexes` (8000).
- Returns `list[HexCell]` — each cell has `h3_id`, centroid `lat`, `lng`.

### Step 3: Data fetch
**`engine/data_osm.py → fetch_all_layers(tag_sets, bbox)`**
- Builds ONE Overpass QL union query for all layers' tags simultaneously.
- Tries 3 Overpass endpoints sequentially, 50s timeout each.
- Falls back to bounded-concurrency per-layer fetches if union fails.
- Client-side classification: POI is assigned to each layer whose tags it matches.
- 6h in-memory cache.

**`engine/data_places.py → fetch_places_pois(types, keyword, bbox)`**
- Sample grid of probe points (spacing ≈ 2×1500m probe radius, max 25 points).
- Google Places Nearby Search per point, deduplicated by `place_id`.
- Max 2 pagination pages per point.

**`engine/poi_merge.py → merge_pois(places_pois, osm_pois)`**
- Spatial dedup: if a Places and OSM POI are within ~40m, keep Places primary.
- Used for consumer POI layers where both sources are queried.

### Step 4: Pass A scoring — all hexes
**`engine/scoring.py → pass_a(spec, hexes, layer_pois)`**
- For each layer: builds scikit-learn `BallTree` from POI lat/lng.
- Counts POIs within `proxy_radius_m` of each hex centroid using `count_within()`.
- `fit_normalization()`: percentile normalization (default p5–p95) per layer.
- `normalize()`: maps raw count to 0–1; direction-applied (negative layers inverted).
- Composite = weighted mean over **layers with data only** (missing layers excluded, weight renormalized).
- Returns `(composite_array, scores_dict)`.

**Missing-data handling:** A layer with 0 POIs is flagged `has_data=False`. It contributes NOTHING to the composite. The composite is renormalized over layers with data. If a required (`required=True`) layer has no data, all candidates are withheld.

### Step 5: Spatial masks (applied after Pass A, before candidate selection)

Applied in order, each ORed into the global `excluded` boolean array:

| Mask | Logic | Code |
|---|---|---|
| **Exclusion buffers** | Any hex within `bufferM` of an exclusion POI set | `scoring.exclusion_mask()` |
| **Waterfront corridor** | If `spec.waterfront.isWaterfront`: hexes outside `corridorWidthM` of water edge | `corridors.corridor_mask()` |
| **Linear corridor gates** | `spec.corridors` entries — true distance to OSM way geometry | `corridors.distance_to_lines_m()` + `corridor_mask()` |
| **Water centroid mask** | Hex centroid inside OSM water body | `water.water_mask()` |
| **Water overlap mask** | Hex >30% water area | `water.water_overlap_mask()` |
| **Railway area mask** | Hex inside railway landuse polygon or within 40m of rail track | `buildability.centroid_in_polygon_mask()` + `line_buffer_mask()` |
| **Ghat mask** | Hex within 50m of named ghat feature | `buildability.point_buffer_mask()` |
| **Heritage/open-space mask** | Hex inside park, sacred, heritage, cemetery, open ground | `buildability.centroid_in_polygon_mask()` |
| **Maidan mask** | Hex within 75m of named maidan/parade ground | `buildability.point_buffer_mask()` |

Water + buildability masks apply only to commercial/waterfront briefs (decided by `_buildability_flags(spec)` regex check on business type).

### Step 6: Candidate selection
**`scoring.select_candidates(composite, hexes, excluded, top_k, min_separation_rings)`**
- Greedy: iterate hexes sorted by composite (descending).
- Skip excluded hexes.
- Skip hexes within `min_separation_rings` H3 rings of any already-selected candidate (spatial dedup to prevent cluster picking).
- Select up to `refine_top_k` (=12) candidates for Pass B.

### Step 7: Pass B refinement — top candidates only
**`engine/catchments.py → fetch_isochrones(cells, mode, minutes)`** (v1.3.0+):
- Primary: Google Routes `computeRouteMatrix` — samples N points around each candidate at multiple radii + bearings, builds convex hull of reachable points → approximate isochrone polygon.
- Fallback: ORS `/v2/isochrones/{profile}` — true graph-based isochrone polygon.
- Final fallback: Pass-A Euclidean proxy (no refinement).
- GCS cache keyed by `(h3_id, mode, minutes)`.

**`engine/traffic.py → traffic_catchment(origin, demand_points, max_minutes)`**
- Uses Google Routes `computeRouteMatrix` to count demand POIs reachable within N minutes of typical evening-peak drive (18:00 IST weekday).
- Only for `trafficAware=True` drive layers (destination businesses: clinic, dark kitchen, supermarket, etc.).

**`engine/routing.py → evaluate_route_constraint(rc, cells, targets, railway_lines)`**
- ORS Directions per candidate → real network distance, walk/drive time, railway-crossing detection.
- Mandatory route constraints (`required=True`): candidates that fail are excluded.

### Step 8: Re-rank with refined values
**`scoring.refit_refined_layers()`** — refit normalization on Pass B values (different scale than Euclidean grid).  
**`scoring.composite_for_hex()`** — uses refined values where available, Euclidean proxy otherwise.  
Finals = top `spec.output.topN` by refined composite.

### Step 9: Geographic critic checks
- `river_dists`: true distance of each final candidate to water edge.
- `build_status`: commercial viability proxy (road access within 120m OR commercial POI within 200m).
- `wf_corridor_unenforced`: if waterfront brief but no river geometry found → `analysisStatus=insufficient_viable_land`.
- **Competition cap** (`_cap_competition_whitespace()`): for commercial briefs, caps competition whitespace benefit if demand/F&B baseline is weak.

### Step 10: Viability gate
- `min_viable_score`: 5.0 for commercial/premium/strict-corridor briefs; 4.5 otherwise.
- Candidates below threshold: `recommended=False`, shown as raw diagnostic.
- `recommendationWithheld=True` when `analysisStatus` is `unreliable` or `insufficient_viable_land`.

### Step 11: Explanation pass
**`engine/results.py → write_explanations(spec, locations)`**
- Single `gpt-5.4-nano` call → JSON `{summary, reasonings[]}`.
- Prompt includes per-candidate factor scores with exact numbers and direction labels.
- Returns to caller; `reasoning` field set per location.

### Step 12: Multi-score computation
**`engine/multi_score.py → compute_multi_scores(locations)`**
- `relativeRankScore`: percentile rank among non-excluded candidates (3+7×rank_fraction).
- `absoluteViabilityScore`: composite + data coverage penalty + hard constraint penalty + archetype floor.
- `confidenceScore`: coverage fraction × 7 + routing (1) + geometry (1) + evaluated (1) − low-confidence penalty.
- `recommendationStatus`: RECOMMENDED / CANDIDATE_ZONE / WEAK_CANDIDATE / RAW_DIAGNOSTIC / EXCLUDED.

### Step 13: Evidence trail assembly
**`engine/evidence_builder.py → assemble_evidence_trail()`**
- `QueryTracker` records all OSM/Places/ORS/Internal calls during the job.
- Assembles `EvidenceTrail` with: provider queries, factor evidence (raw/normalized/weighted per candidate), candidate evidence, exclusion ledger, scoring evidence.
- `safe_dict()` scrubs all secret-looking keys before attachment to job result.

---

## 7. Data Sources and Proxy Layers

| Layer Name | Source | Used For | Direct or Proxy | Confidence | Known Weaknesses |
|---|---|---|---|---|---|
| Student catchment | OSM `amenity=school/college/university` | Student demand proxy | Proxy (enrollment data unavailable) | Medium | OSM undercounts private coaching centres; enrollment varies widely by institution size |
| Pedestrian transit access | OSM `railway=station`, `public_transport=station`, `highway=bus_stop` | Walk accessibility | Direct (count) / Proxy (quality) | Medium | Station counts but not ridership or platform capacity |
| Direct cafe competition | Google Places `cafe` / OSM `amenity=cafe` | Competition penalty | Direct (count) | High | Places coverage better but may miss new openings; informal roadside stalls absent |
| Commercial co-tenancy | Google Places `store/shopping_mall/restaurant` | Commercial anchor density | Proxy | Medium | Franchise chains better covered than independent shops |
| Dead frontage / barrier | OSM `railway=rail`, `highway=motorway`, `barrier=wall` | Frontage obstruction penalty | Proxy (infrastructure) | Medium | Railway proximity proxy; actual frontage visibility unmeasured |
| Residential demand | OSM `building=residential/apartments`, `landuse=residential` | Drive-catchment population | Proxy (building count not households) | Medium | OSM building footprints very incomplete in many Indian cities |
| Supermarket competition | Google Places `supermarket` | Competition density | Direct (count) | Medium | Discount-format identification unreliable; informal markets absent |
| Commercial land density | OSM `landuse=commercial/retail` | Large parcel availability | Proxy | Medium | OSM landuse coverage patchy; does not verify 10,000 sq ft availability |
| Highway/arterial access | OSM `highway=primary/trunk` (corridor gate) | Must-be-near arterial | Direct (geometry) | High | Correct for OSM-mapped roads; unofficial arterials may be absent |
| Water bodies | OSM `natural=water`, `waterway=riverbank`, `water=*` | Exclusion mask | Direct (geometry) | High | OSM relation-based rivers (Hooghly) require `out geom` query; some waterways missing |
| Railway land | OSM `landuse=railway`, `railway=yard/platform/station` | No-build exclusion | Direct | High | Some unmapped sidings present in reality |
| Ghat areas | OSM named features matching `[Gg]hat` | No-build exclusion (50m buffer) | Direct (named node) | Medium | Not all ghats tagged as ghats in OSM |
| Heritage / protected | OSM `historic=*`, `boundary=protected_area`, `amenity=place_of_worship`, `leisure=park` | No-build exclusion | Direct | Medium | Temple/mosque nodes frequently missing; some parks unmapped |
| Maidan / open ground | OSM named features matching "Maidan|Parade Ground" | No-build exclusion (75m buffer) | Direct (name-matched node) | Medium | Many urban maidans have no dedicated tag beyond the name |
| Office/daytime demand | OSM `office=yes`, `building=office`, `landuse=commercial` | Drive-catchment demand | Proxy | Medium | IT parks often as single landuse polygon, not individual offices |
| Road network (commercial viability) | OSM `highway=primary/secondary/tertiary/residential` | Frontage proxy | Direct (geometry) | Medium | Only ~120m threshold; does not measure actual traffic |
| Traffic-aware drive catchment | Google Routes Routes Matrix | Reachable demand in typical traffic | Direct (routing) | Medium | Fixed 18:00 IST departure; congestion varies by day/season |
| ORS Isochrones | OpenRouteService | Walk/drive catchment polygon | Direct (routing) | Medium | Free tier limited to 500/day; may miss traffic conditions |
| Google Places isochrone (v1.4+) | Google Routes computeRouteMatrix | Approximate catchment polygon | Proxy (convex hull of reachable sample points) | Medium | Sample-point convex hull ≠ true isochrone; underestimates irregular catchments |
| Rent data | **NONE** | ❌ Not available | N/A | N/A | Rent is always `unvalidatable`; never inferred or scored |
| Parcel availability | **NONE** | ❌ Not available | N/A | N/A | 10,000 sq ft footprint cannot be verified from OSM/Places |

---

## 8. Scoring Framework

### Factor selection
The deterministic planner (`deterministic_planner.py`) replaces the LLM's freely-chosen factors with the canonical archetype's frozen factor set. The LLM's role is explanation text only. Each `CanonicalFactor` has a fixed `weight` (integer out of 100), `direction` ("positive" | "negative"), and catchment parameters.

### Weight assignment
Weights come from the canonical archetype registry (`canonical_archetypes.py`). They sum to 100 for each archetype. Examples:

| Archetype | Factor | Weight |
|---|---|---|
| student_qsr_cafe | student_catchment_proxy | 32 |
| student_qsr_cafe | pedestrian_transit_access | 27 |
| student_qsr_cafe | direct_cafe_competition | 18 |
| student_qsr_cafe | commercial_cotenancy | 14 |
| student_qsr_cafe | frontage_barrier_penalty | 9 |
| dark_kitchen | residential_delivery_demand | 38 |
| dark_kitchen | office_delivery_demand | 22 |
| dark_kitchen | kitchen_competition | 20 |
| dark_kitchen | road_delivery_access | 20 |
| large_format_retail | drive_residential_demand | 38 |
| large_format_retail | supermarket_competition | 28 |
| large_format_retail | commercial_land_density | 20 |
| large_format_retail | office_daytime_demand | 14 |

### Score normalization (`scoring.py → fit_normalization()` + `normalize()`)
```
method="percentile" (default): lo = p5 of raw counts, hi = p95
method="minmax":               lo = min, hi = max
```
`normalize(value, lo, hi, direction)`:
- positive: `clip((value-lo)/(hi-lo), 0, 1)`
- negative: `1 - clip((value-lo)/(hi-lo), 0, 1)`

### Composite score (`composite_for_hex()`)
```
composite (0–1) = Σ(layer.weight × normalized_score) / present_weight
present_weight  = Σ(layer.weight for layers with has_data=True)
final_score (0–10) = round(composite × 10, 1)
```
**Key invariant**: layers with no data contribute NOTHING. The composite is renormalized over present-weight layers only. A layer is never scored 0 or 10 from absence.

### Hard exclusions vs soft penalties
- **Hard exclusions** (`spec.exclusions`): any hex within the buffer radius is MASKED OUT entirely (boolean excluded array). No score computed.
- **Corridor gates** (`spec.corridors`): hexes outside (include mode) or inside (exclude mode) a distance threshold are masked out. True geometry, not POI centroids.
- **Route constraints** (`spec.routeConstraints`): candidates that fail ORS-computed route pass/fail are excluded from ranking.
- **Soft penalties**: implemented as `direction="negative"` scoring layers. They DISCOUNT scores but never remove candidates.

### How "recommended" status is assigned

**Step 1:** `multi_score.py` computes `relativeRankScore`, `absoluteViabilityScore`, `confidenceScore`.

**Step 2:** `determine_recommendation_status()` applies threshold rules:
```
RECOMMENDED       if R≥6.0 AND V≥5.0 AND C≥5.0 AND no critic downgrade AND not excluded
CANDIDATE_ZONE    if R≥4.0 AND V≥3.5 AND C≥3.0
WEAK_CANDIDATE    if R>3.0 OR V>2.5
RAW_DIAGNOSTIC    otherwise
EXCLUDED          if excluded=True OR hard constraint failed
```

**Step 3:** The viability gate in `jobs.py`:
```python
l["recommended"] = bool(
    not l.get("excluded") and not l.get("scoreWithheld")
    and l.get("hardConstraintPass", True)
    and (l.get("mcda_score") or 0) >= min_score   # 5.0 for commercial, 4.5 otherwise
)
```

**Step 4:** Analysis-level status:
- `reliable` → normal recommendation display
- `weak` → results shown but flagged
- `unreliable` → `recommendationWithheld=True`; raw candidates shown behind opt-in
- `insufficient_viable_land` → no candidates survived masks; relaxation suggestions shown

### Competition whitespace cap (`_cap_competition_whitespace()`)
For commercial briefs, if a candidate has high competition-whitespace score (low competition → high inverted score) but very low demand and F&B signals, the competition factor is capped at 3.0 or 4.0. Prevents "perfect whitespace in a dead area" from producing a false winner.

---

## 9. Reliability and Safeguards

### 9.1 Data absence — never fabricated scores
- `has_data=False` layers excluded from composite (not scored 0 or 10).
- `evidenceBasis="insufficient-data"` shown in UI and PDF.
- `scoreWithheld=True` when NO layer has data — composite not shown.

### 9.2 Waterfront false-positive guard (`llm.py`)
```python
if isinstance(new_spec, dict) and (new_spec.get("waterfront") or {}).get("isWaterfront"):
    _det = detect_waterfront(prompt)
    if not _det.get("isWaterfront"):
        new_spec["waterfront"] = {"isWaterfront": False, ...}  # override
```
Prevents "EM Bypass" or other road-near-water prompts from triggering strict riverfront corridor.

### 9.3 Spec staleness guard (`llm.py`)
```python
if _cur_biz not in ("generic",) and _spec_biz not in ("generic",) and _cur_biz != _spec_biz:
    spec = None  # discard stale spec
```
Prevents constraints from prompt A leaking into prompt B in the same session.

### 9.4 Empty-source layer repair
`analyses.py → _repair_spec_layers()`: strips layers with empty OSM tags or empty Places types before `SpecV2.model_validate()`, preventing 422 errors.  
`canonical_archetypes.py → _DEFAULT_OSM_TAGS/PLACES_TYPES`: canonical `to_layers_dict()` always outputs valid default tags.

### 9.5 Required-constraint gate
If a layer is marked `required=True` (encodes a hard constraint) and `has_data=False`, all candidates get `excluded=True` and `scoreWithheld=True`. No ranked output is shown.

### 9.6 Waterfront corridor enforcement
- If `spec.waterfront.isWaterfront=True` but no river line geometry found: `waterfront_corridor_failed=True` → `recommendationWithheld=True` (never keep-all).
- Corridor width clamped to ≤500m; "strictly" wording → 250m.

### 9.7 No-eligible-candidate handling
If all candidates fail required route constraints: `no_eligible=True`, `analysisStatus="unreliable"`.

### 9.8 Unvalidatable constraint disclosure
Any constraint with `status="unvalidatable"` (rent, zoning, footprint) is:
- Listed in `spec.feasibility.unvalidatable`.
- Forces `feasibility.status="tradeoffs"` (never `not_feasible`).
- Shown in UI and PDF as "requires site visit".

### 9.9 Post-execution self-critique (`services/critic.py`)
Active in `balanced`/`high` cost modes only (off by default).
`critique_analysis()` sends computed results back to `gpt-5.4` for review on:
- Geographic sanity
- Non-discriminating factors
- Thin data (high-weight layers with few features)
- Constraint satisfaction

Returns `verdict: "reliable"|"weak"|"unreliable"`. `unreliable` → `recommendationWithheld=True`.

### 9.10 Evidence trail (`models/evidence.py` + `engine/evidence_builder.py`)
Every completed analysis attaches `evidenceTrail` to `job.result`:
- Provider query records (no secrets via `_scrub_secrets()`)
- Per-factor per-candidate raw/normalized/weighted scores
- Exclusion ledger (H3 cells removed per mask type + candidate exclusions)
- Scoring formula description
- Audit reproducibility disclaimer

### 9.11 Proxy warnings
`proxyWarning` field in layer spec surfaced in `SpecSummaryCard` (⚠ icon) and `ResultsDrawer`.  
Examples: "Schools/colleges as student proxy; actual enrollment data unavailable."

### 9.12 Competition whitespace cap
`_cap_competition_whitespace()` in `jobs.py`: prevents competition whitespace from inflating a weak-demand area's score.

---

## 10. Known Current Gaps / Issues

### GAP-1: Rent constraint is unverifiable
**Where:** `prompts.py` P7 (UNVALIDATABLE), `spec.py` constraint model.  
**Why it matters:** User specifies "rent cannot exceed ₹20/sq ft". The system correctly marks this unvalidatable and proceeds with spatial analysis, but has no mechanism to filter candidates by actual rent. A candidate that scores #1 spatially could be far over the rent ceiling.  
**Type:** Data gap  
**Severity:** High (client may act on a candidate that is economically infeasible)  
**Mitigation currently:** Explicit caveat in UI and PDF: "rent cannot be validated from available data — flagged for site visit".

### GAP-2: Large-format footprint (10,000 sq ft) is unverifiable
**Where:** `large_format_retail` archetype; `commercial_land_density` layer uses `landuse=commercial` as proxy.  
**Why it matters:** OSM land-use polygons and Google Places POIs cannot confirm 10,000 sq ft of contiguous buildable area at a specific location.  
**Type:** Data gap  
**Severity:** High for large-format retail; Medium for standard retail  
**Mitigation currently:** `proxyWarning` on the `commercial_land_density` factor; footprint flagged as unvalidatable in constraints.

### GAP-3: Student demand proxy is indirect
**Where:** `student_qsr_cafe` archetype, `student_catchment_proxy` factor (OSM `amenity=school/college/university`).  
**Why it matters:** Number of educational institutions within 10-min walk does not capture actual student population, enrollment size, daytime presence, or student spending behaviour.  
**Type:** Data + methodology  
**Severity:** Medium  

### GAP-4: H3 hex ranking instead of parcel-level siting
**Where:** All analysis output. `siteClaimLevel="micro_market_zone"`.  
**Why it matters:** H3 resolution 9 ≈ 0.1 km² (≈316m hex edge). The "top location" is a ~100m×100m zone, not a specific address or buildable plot. Multiple competing properties exist within a single recommended hex.  
**Type:** Architecture  
**Severity:** Medium (portal is designed for screening, not parcel selection; always disclosed)  

### GAP-5: Metro station geocoding ambiguity
**Where:** `engine/study_area.py → geocode()`. OSM exclusions targeting "any metro station" use `tags=["railway=station"]` — fetches ALL stations, not only metro.  
**Why it matters:** Railway mainline stations get the same exclusion buffer as metro stations. In some cities (Mumbai) this matters significantly.  
**Type:** Data  
**Severity:** Medium  

### GAP-6: Drive-time approximation for catchment
**Where:** `traffic.py` — fixed 18:00 IST weekday departure for traffic-aware catchments.  
**Why it matters:** Catchment may vary significantly by time of day, day of week, or season. A clinic's drive catchment at 10:00 AM differs from 17:00 PM.  
**Type:** Data + methodology  
**Severity:** Low-Medium  

### GAP-7: Session state cross-contamination (fixed but fragile)
**Where:** `llm.py → chat_turn()` spec staleness guard.  
**Why it matters:** The spec staleness guard triggers only when both current and spec business types are non-generic and different. A "generic" prompt after a specific analysis can still carry forward stale constraints.  
**Type:** UX / state management  
**Severity:** Medium  

### GAP-8: Score precision illusion
**Where:** `results.py → build_location()` — scores like "7.3/10" displayed.  
**Why it matters:** Given proxy data and OSM incompleteness, a 0.1-point score difference carries no meaningful accuracy. Users may interpret ranked order as precisely calibrated.  
**Type:** UX  
**Severity:** Medium  
**Mitigation:** Multi-dimensional R/V/C scores and explicit confidence flags help; score is a screening signal, not an exact measurement.

### GAP-9: Google Places isochrone is approximate
**Where:** `engine/catchments.py → _google_isochrone()` — samples N bearings × M radii → convex hull.  
**Why it matters:** A convex hull of reachable sample points is not a true isochrone. Irregular road networks, dead ends, and water features create actual catchments that differ significantly from the convex hull.  
**Type:** Methodology  
**Severity:** Medium  

### GAP-10: LLM prompt contamination in multi-turn sessions
**Where:** `llm.py → convo` construction. The CURRENT SPEC DRAFT is injected as a system message for every turn.  
**Why it matters:** If `_strip_empty_source_layers()` or the staleness guard fails, a stale spec from a previous brief can corrupt the new analysis. The guards cover the most common cases but edge cases remain.  
**Type:** Architecture  
**Severity:** Medium  

---

## 11. Test Prompt Behaviour

### Prompt 1: Quick-service cafe targeting students near Ruby Crossing and EM Bypass

| Field | Value |
|---|---|
| Business type | `student_qsr_cafe` (detected via `detect_student_qsr()`: "students" + "cafe") |
| Study area | Convex hull of geocoded ["Ruby Crossing, Kolkata", "EM Bypass, Kolkata"] + 500m buffer |
| Hard constraints | "near EM Bypass" → `corridors` entry with `highway=primary` tags, `mode=include` |
| Factors | student_catchment_proxy (32%), pedestrian_transit_access (27%), direct_cafe_competition (18%), commercial_cotenancy (14%), frontage_barrier_penalty (9%) |
| Weights | Deterministic registry (not LLM) |
| H3 resolution | 9 |
| Isochrones | Walk-based, ORS → GCS cache → Euclidean fallback |
| Candidate generation | Greedy topK=12, min_separation=2 rings |
| Output type | candidate_zones (siteClaimLevel=micro_market_zone) |
| Key code paths | `detect_waterfront()` guard prevents false riverfront; `_DEFAULT_OSM_TAGS["student_catchment_proxy"]` = `["amenity=school","amenity=college","amenity=university"]` |
| Typical warnings | "Student catchment proxy: enrollment data unavailable" |
| planningFingerprint | `pfp_774efc1cee0a` (v1.3.0 engine version) |
| Result reliability | `weak` to `reliable` depending on OSM data density in the study area |

### Prompt 2: Premium riverside restaurant between Howrah Bridge and Vidyasagar Setu

| Field | Value |
|---|---|
| Business type | `premium_restaurant` |
| Study area | Convex hull of Howrah Bridge + Vidyasagar Setu geocoded points + hull buffer |
| Waterfront detection | `detect_waterfront("riverside")` → `isWaterfront=True`, `strictness=normal`, `corridorWidthM=350m` |
| Hard constraints | Waterfront corridor (within 350m of Hooghly bank), heritage/ghat exclusions |
| Factors | affluent_residential_catchment (30%), premium_cotenancy (25%), direct_restaurant_competition (20%), destination_accessibility (15%), tourist_leisure_footfall (10%) |
| Key masks | Water centroid + overlap masks; railway; ghat buffer (50m); heritage/protected |
| Output type | Potentially `insufficient_viable_land` if all hexes removed by water+ghat+heritage masks |
| Key code paths | `_viability_suggestions()` gives relaxation options (widen to 500m, allow other bank) |
| Warnings | "Strictly riverfront corridor active (350m)"; ghat/heritage removals reported in `maskStats` |

### Prompt 3: Discount supermarket in Sector V, primary arterial road, rent ≤ ₹20/sq ft

| Field | Value |
|---|---|
| Business type | `large_format_retail` (parser: `discount_supermarket` pattern) |
| Study area | Geocoded "Sector V, Kolkata" + buffer |
| Arterial road | `corridors` entry: `highway=primary` + `highway=primary_link`, `mode=include`, `maxDistanceM=250m` |
| Rent constraint | `status=unvalidatable` → `feasibility.tradeoffs`; never blocks execution |
| Footprint constraint | `status=unvalidatable`; flagged in constraints table |
| H3 resolution | 8 (drive-catchment archetype) |
| Factors | drive_residential_demand (38%), supermarket_competition (28%), commercial_land_density (20%), office_daytime_demand (14%) |
| Key code paths | `_repair_spec_layers()` strips any empty-source layers before validation; `to_layers_dict()` provides default tags |
| Warnings | "Rent cannot be validated from available data"; "Large-format parcel (10,000 sq ft) unverifiable" |
| specValid | True (after `to_layers_dict()` default tags fix) |
| chatReady | True; "Start analysis" button appears |

### Prompt 4: Dark kitchen in South Kolkata, 10-min drive of Ballygunge Phari, outside 1km metro

| Field | Value |
|---|---|
| Business type | `dark_kitchen` |
| Study area | Enumerated South Kolkata localities (per P7e consultant principle): Ballygunge, Gariahat, Jadavpur, Tollygunge, etc. |
| Route constraint | "within 10-min drive of Ballygunge Phari" → `spec.routeConstraints` entry, mode=drive, maxMinutes=10, targetKeyword="Ballygunge Phari, Kolkata" |
| Exclusion | "outside 1km of any metro station" → `spec.exclusions`, `bufferM=1000`, tags=`["railway=station","public_transport=station"]` |
| H3 resolution | 8 (drive-catchment archetype) |
| Factors | residential_delivery_demand (38%), office_delivery_demand (22%), kitchen_competition (20%), road_delivery_access (20%) |
| ORS routing | `evaluate_route_constraint()` → real network routing per top candidate; fails → candidate excluded |
| Traffic-aware | `trafficAware=True` on residential demand layer if cost mode is balanced/high |
| Key risks | If ORS unavailable: route constraint status=unavailable → candidates may be withheld; `route_unavailable` list reported |
| Warnings | "Metro station exclusion applied (1km buffer)"; ORS unavailability if key not set |

---

## 12. Backend / API Contracts

### POST /api/v2/chat

**Request:**
```json
{
  "messages": [{"role": "user"|"assistant", "content": "string (max 12,000 chars)"}],
  "spec":    { /* current SpecV2 draft or null */ },
  "context": {"resultCount": 3, "csvPointCount": 0}
}
```

**Response:**
```json
{
  "ok": true,
  "reply": "markdown string shown to user",
  "stage": "chat"|"framework"|"ready",
  "spec": { /* SpecV2 dict */ },
  "specStatus": "empty"|"draft"|"complete",
  "readyToExecute": false,
  "feasibility": {"status": "tradeoffs", "explanation": "...", "unvalidatable": ["rent"]},
  "unsupported": [{"requested": "...", "fallback": "..."}],
  "specValid": true,
  "specValidationError": null,
  "model": "gpt-5.4-mini",
  "usage": {"promptTokens": 1234, "completionTokens": 456, "totalTokens": 1690}
}
```

### POST /api/v2/analyses

**Request:**
```json
{"spec": { /* complete SpecV2 */ }}
```

**Responses:**
- `200`: `{"ok": true, "jobId": "uuid4-string"}`
- `409`: `{"error": "Plan is marked NOT FEASIBLE...", "conflicts": [...], "relaxationOptions": [...]}`
- `422`: `{"detail": "spec validation failed: [...]"}`

### GET /api/v2/analyses/{jobId}

**Response (polling):**
```json
{
  "ok": true,
  "status": "queued"|"running"|"done"|"error",
  "progress": 64,
  "phase": "buildability",
  "message": "Applying buildability masks...",
  "result": { /* AnalysisResult when done */ },
  "error": null
}
```

### AnalysisResult (key fields)
```json
{
  "summary": "Executive summary string",
  "business_type": "discount supermarket",
  "target_location": "Kolkata",
  "locations": [
    {
      "name": "AQ Block (west)",
      "lat": 22.58, "lng": 88.44,
      "mcda_score": 6.4,
      "criteria_breakdown": [
        {"name": "Student catchment proxy", "weight": 0.32, "score": 7.2,
         "rawValue": 8.0, "direction": "positive",
         "justification": "8 features within 10-min walk",
         "evidenceBasis": "osm-observed"}
      ],
      "exclusions": [{"rule": "waterfront_corridor", "passed": true, "detail": "..."}],
      "excluded": false,
      "recommended": true,
      "relativeRankScore": 8.5,
      "absoluteViabilityScore": 6.2,
      "confidenceScore": 5.8,
      "recommendationStatus": "RECOMMENDED",
      "riverDistanceM": 420.0,
      "inWaterfrontCorridor": null,
      "buildabilityStatus": "viable",
      "hardConstraintPass": true,
      "reasoning": "2-3 sentence assessment"
    }
  ],
  "hexGrid": [{"h3": "string", "score": 7.2, "excluded": false, "boundary": [[lat,lng],...], "layerScores": {...}}],
  "catchments": [{"locationName": "...", "layerName": "...", "mode": "walk", "minutes": 10, "polygon": [[lat,lng],...]}],
  "studyAreaBoundary": [[lat,lng],...],
  "analysisStatus": "reliable",
  "recommendationWithheld": false,
  "maskStats": {"railwayRemoved": 2, "waterOverlapRemoved": 3},
  "suggestions": [],
  "waterfront": null,
  "critique": null,
  "dataQuality": [{"name": "Student catchment proxy", "provider": "osm", "weight": 0.32, "featureCount": 12, "lowCoverage": false, "nonDiscriminating": false}],
  "evidenceTrail": { /* EvidenceTrail */ },
  "planningMode": "deterministic",
  "planningFingerprint": "pfp_774efc1cee0a",
  "archetypeKey": "student_qsr_cafe",
  "criticEnabled": false,
  "constraintEnforcementLevel": "advisory"
}
```

### GET /api/v2/analyses/{jobId}/evidence
Returns `{"ok": true, "evidenceTrail": { /* EvidenceTrail */ }}`.

### GET /api/v2/analyses/{jobId}/evidence.json
Returns downloadable JSON file (no secrets).

---

## 13. Frontend Components

### FloatingAssistant.tsx
- Chat panel (bottom-left, collapsible).
- Input: textarea with auto-grow; Enter to send (Shift+Enter = newline).
- Per-message action buttons (copy, edit-and-resend, share-prompt) — appear on hover.
- Inline "Run Analysis" green button appears when `chatReady=true && chatStage==='ready'` (v1.4 feature, reverted in v1.3).
- Context chips: active memory items (business type, city, constraints, CSV points).
- Prompt quota badge for non-admin users.
- Welcome screen with example prompts and quick-start scenario chips.

### SpecSummaryCard.tsx
- Shown when `chatStage !== 'chat'` and `chatSpec` is not null.
- Factor table: id, name, weight %, catchment, confidence badge (H/M/L).
- Feasibility banner: ✅ / ⚠️ / ❌ / ❓.
- Constraints table with type (hard/soft) and status (satisfiable/unvalidatable/conflicting).
- Misleading variables section (yellow collapsible).
- Scenarios (chips: Balanced, Student-heavy, Frontage-first).
- `▶ Start analysis` button — only visible when `readyToExecute=true` and `!blocked`.

### ResultsDrawer.tsx
- Slides in from the right after analysis completion.
- Shows: summary, withheld/insufficient banners, analyst review (if critic active), benchmark comparison.
- Analysis Assumptions collapsible: sector, radius, constraints, data sources, deterministic planning badge.
- Map factor toggles: choropleth by factor name.
- Location cards: rank, name, lat/lng, score, R/V/C pills, expand for criteria bars, OSM signals, route metrics, exclusion reasons.
- Evidence Trail collapsible (v1.3.0): provider query table, factor evidence (expandable per factor), candidate breakdown, exclusion ledger, scoring formula, JSON export button.

### MapView.tsx
- Leaflet map with 5 basemap options (light, dark, voyager, satellite, OSM street).
- Hex grid choropleth: colour ramp 0→red→amber→green (direction-applied scores).
- Candidate markers: numbered pins (green=recommended, grey=excluded/raw, blue=selected).
- Isochrone catchment polygons: walk=green, drive=purple.
- AOI study-area boundary polygon.
- User CSV points (if uploaded).
- User-point buffer circles (if `showBuffers=true`).

### GuidedTour.tsx
- 9-step walkthrough with highlight + tooltip.
- Auto-starts 1.2s after first non-admin login (localStorage `sg_tour_seen_v14`).
- Responsive: mobile collapses tooltip to bottom-center panel.

### TopBar.tsx
- Logo (links to stratageo.in), Live badge, version badge.
- Session history (clock icon), Methodology dialog (info icon), PDF export (download icon), New analysis (+).
- Dark mode toggle, basemap picker.
- User avatar + admin badge.

---

## 14. Important Types / Interfaces

### `SpecV2` (Python Pydantic, `models/spec.py`)
The analysis contract between the LLM and the spatial engine.

```
version: "2.0"|"2.1"|"2.2"
objective: str
businessType: str
studyArea: StudyArea         # places|bbox|point_radius
grid: Grid                   # H3 resolution 7-10
layers: list[Layer]          # scoring factors
exclusions: list[Exclusion]  # hard buffer exclusions
corridors: list[Corridor]    # linear-feature gates
routeConstraints: list[RouteConstraint]  # ORS routing gates
output: Output               # topN, minCandidateSeparationHexRings
execution: Execution         # isochroneRefinement, refineTopK
constraints: list[Constraint] # extracted hard/soft constraints for display
feasibility: Feasibility     # status, explanation, conflicts, unvalidatable
plan: Plan                   # methodology, assumptions, scenarios, risks
waterfront: WaterfrontSpec   # isWaterfront, strictness, corridorWidthM
rawIntent: RawIntent         # parser output
archetypeKey, planningMode, planningFingerprint, ...
```

### `AnalysisResult` (TypeScript, `types/index.ts`)
The full result payload from the engine, received by the frontend.

```typescript
interface AnalysisResult {
  summary: string
  locations: LocationData[]       // ranked candidates
  hexGrid?: HexGridCell[]         // per-hex scores for choropleth
  catchments?: CatchmentOutline[] // isochrone polygons
  studyAreaBoundary?: [number,number][]
  analysisStatus: 'reliable'|'weak'|'unreliable'|'insufficient_viable_land'
  recommendationWithheld: boolean
  maskStats: Record<string, number>
  waterfront: {...} | null
  critique: AnalysisCritique | null
  dataQuality: FactorDataQuality[]
  evidenceTrail?: EvidenceTrail   // v1.3.0
  planningMode?: 'deterministic'|'advisory'
  planningFingerprint?: string
  archetypeKey?: string
}
```

### `LocationData` (TypeScript, `types/index.ts`)
Per-candidate result.

```typescript
interface LocationData {
  name: string; lat: number; lng: number
  mcda_score: number              // 0–10 composite
  criteria_breakdown: MCDACriteria[]  // per-factor scores
  exclusions: ExclusionCheck[]
  excluded: boolean
  recommended?: boolean           // passed viability gate
  relativeRankScore?: number      // vs peers this run
  absoluteViabilityScore?: number // vs archetype baseline
  confidenceScore?: number        // data trustworthiness
  recommendationStatus?: string   // RECOMMENDED|CANDIDATE_ZONE|...
  riverDistanceM?: number | null
  inWaterfrontCorridor?: boolean | null
  buildabilityStatus?: string
  hardConstraintPass?: boolean
  routeMetrics?: Record<string, RouteMetric>
  reasoning: string
}
```

### `EvidenceTrail` (Python Pydantic, `models/evidence.py` / TypeScript `types/index.ts`)
Audit record for every completed analysis.

```
evidenceVersion: "1.3.0"
jobId, analysisId, createdAt, appVersion, engineVersion
prompt: { rawPrompt, planningFingerprint, archetypeKey, planningMode }
dataSnapshot: { snapshotId, providerMode, cacheHit }
studyArea: { geometryHash, h3CellCountBeforeMasks, h3CellCountAfterMasks }
providerQueries: ProviderQueryEvidence[]    # no secrets
factors: FactorEvidence[]                  # per-factor per-candidate breakdown
candidates: CandidateEvidence[]
exclusions: ExclusionEvidence[]            # h3_cell + candidate exclusions
scoring: ScoringEvidence
recommendationSummary: {...}
limitations: string[]
```

---

## 15. How to Run Locally

### Prerequisites
- Python 3.13, Node 22, npm
- OpenAI API key
- Google Places/Geocoding API key (recommended)
- ORS API key (optional — degrades to Euclidean proxy)
- Firebase project with Auth and Firestore enabled

### Backend
```bash
cd backend-py
pip install -r requirements.txt
cp .env.example .env        # fill in API keys
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Environment variables needed in `backend-py/.env`:
```
OPENAI_API_KEY=sk-...
GOOGLE_PLACES_API_KEY=AIza...
ORS_API_KEY=...
FRONTEND_ORIGINS=http://localhost:5173
APP_SHARED_TOKEN=                  # empty = no token gate
```

### Frontend
```bash
# Project root
npm install
# Create .env.local with:
# VITE_PY_BACKEND_URL=http://127.0.0.1:8000
# VITE_CONVERSATIONAL_MODE=1
# VITE_APP_MODE=live
npm run dev    # starts Vite dev server at localhost:5173
```

### Tests
```bash
cd backend-py
pytest -q
```
No lint script configured in `package.json`. TypeScript check: `npx tsc --noEmit`.

### Build
```bash
npm run build   # TypeScript compile + Vite bundle → dist/
```

### Deploy
```bash
# Backend (Cloud Run)
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project <PROJECT_ID>

# Frontend (GitHub Pages)
git push origin master   # deploy-pages.yml auto-runs on master push
```

---

## 16. Suggested Refactor / Improvement Roadmap

### P0 — Must fix for client reliability

**P0-1: Rent and footprint constraints — provisional output only**  
The portal runs an analysis when rent/footprint are unvalidatable, which is correct. But the final output should more prominently label it as "provisional pending broker verification" rather than a numbered ranked list. The numbered ranking implies more certainty than the data supports.  
*Where to fix*: `ResultsDrawer.tsx` — add a persistent "PROVISIONAL" watermark/badge when `feasibility.status=tradeoffs` and `unvalidatable` contains rent or footprint. Also update PDF export section header.

**P0-2: Fix multi-session spec contamination edge cases**  
The staleness guard (`llm.py`) only fires when both sides are non-generic. "Generic" → specific transitions and vice versa can still carry stale constraints.  
*Where to fix*: In `handleNewChat()` (App.tsx), always clear `chatSpec` when the user clicks "+". Add a more aggressive spec reset for the "chat" stage where the LLM appears to switch domain radically.

**P0-3: Score precision signal**  
Scores displayed to 0.1 precision (e.g., 7.3/10) overstate accuracy. A 7.3 vs 7.1 difference on proxy data is not meaningful.  
*Where to fix*: `ResultsDrawer.tsx` — display rounded to nearest 0.5 or with explicit uncertainty band. Keep full precision in evidence trail.

### P1 — Important for production quality

**P1-1: ORS key missing → all route constraints unverifiable**  
With no ORS key, every route constraint returns `status=unavailable` → all candidates are excluded → `analysisStatus=unreliable`. This is honest but surprising if the user is unaware ORS is not configured.  
*Where to fix*: `health.py` — add `hasOrsKey` to `/health`. `prompts.py` — advise route constraints only when ORS is available.

**P1-2: isochrone polygon is a convex hull approximation**  
Google Routes `computeRouteMatrix`-based isochrones are convex hulls of reachable sample points. They significantly overestimate catchment in irregular road networks.  
*Where to fix*: `catchments.py → _google_isochrone()` — add a note in the catch result or confidence metadata; consider alpha-shape instead of convex hull for better precision.

**P1-3: Reproducible test suite for prompts**  
No integration tests run the 4 canonical prompts end-to-end. Tests are unit-level only.  
*Where to fix*: Add `tests/integration/test_prompt_flows.py` that runs the full chat flow against a mocked LLM and asserts: archetype detected, specValid=True, no waterfront false-positive, no empty-source layers. Run in CI.

**P1-4: Argument for per-archetype confidence floors**  
Current `absoluteViabilityScore` archetype floors are hardcoded in `multi_score.py` for a few archetypes only. Add `confidence_floor` to `CanonicalArchetype`.

### P2 — Useful enhancements

**P2-1: Real parcel/rent validation layer**  
Partner with a property data source (99acres, MagicBricks API, ANAROCK) to validate rent ranges and parcel availability. This would convert the biggest P0 gap into a real feature.

**P2-2: Better audit export**  
Current evidence JSON includes factor scores but not the raw OSM Overpass query or Places response summary. Add anonymised query summary (tag set, bbox, timestamp, feature count) per provider, which is already partially implemented in `QueryTracker`.

**P2-3: State cleanup on new session**  
When `handleNewChat()` fires, ensure `chatSpec`, `chatStage`, `chatReady`, working memory, and `userPoints` are all fully cleared. Currently `userPoints` is cleared but `memory.lastAnalysisTimestamp` persists, which keeps context chips visible.

**P2-4: Scenario chip wiring**  
The `SpecSummaryCard` renders scenario chips (Balanced, Student-heavy, Frontage-first) from `spec.plan.scenarios`. Currently these are display-only. Wiring them to actually re-weight the spec (`onSpecEdit`) and re-run the analysis would add meaningful value.

**P2-5: H3 resolution as user parameter**  
Currently H3 resolution is archetype-driven. Allow the user (via the spec card or system prompt) to explicitly request a finer or coarser grid for a specific area.

---

## 17. File-by-File Reference Appendix

| File | Role | Key Functions / Classes | Key Risks / Notes |
|---|---|---|---|
| `backend-py/app/main.py` | FastAPI app factory | CORS setup, middleware order | SecurityMiddleware must be innermost |
| `backend-py/app/config.py` | All settings | `Settings`, `APP_VERSION`, `ENGINE_VERSION`, `get_settings()` | Never change model defaults without updating changelog |
| `backend-py/app/security.py` | Abuse protection | `SecurityMiddleware.dispatch()`, `_rate_limited()` | GET on `/api/v2/analyses/*` is exempt (is_poll logic) — evidence endpoints follow same pattern |
| `backend-py/app/models/spec.py` | Analysis contract (Pydantic) | `SpecV2`, `StudyArea`, `Layer`, `OsmSource`, `PlacesSource`, `Corridor`, `RouteConstraint`, `detect_waterfront()`, `_is_water_tag()` | `OsmSource.tags_have_kv()` normalizes LLM sloppiness; `min_length=1` on tags is the source of most 422 errors |
| `backend-py/app/models/chat.py` | Chat API models | `ChatRequest`, `ChatResponse`, `validate_spec()` | `specValid=False` → chatReady=False in App.tsx; critical for "Start analysis" button |
| `backend-py/app/models/evidence.py` | Evidence trail schema | `EvidenceTrail`, `_scrub_secrets()`, `safe_dict()` | All secret fields must be in `_SECRET_KEYS` set |
| `backend-py/app/routers/chat.py` | Chat endpoint | `chat()` | Wraps all exceptions in 502 (generic error); never leaks secrets in response |
| `backend-py/app/routers/analyses.py` | Analysis endpoints | `start_analysis()`, `_repair_spec_layers()`, `get_evidence()`, `download_evidence()` | `_repair_spec_layers()` is the last defence against empty-source 422 errors |
| `backend-py/app/routers/health.py` | Health check | `health()` | Exposes feature flags, model config, key presence — never key values |
| `backend-py/app/services/llm.py` | LLM chat turn | `chat_turn()`, `_strip_empty_source_layers()`, `is_go_signal()`, `is_framework_signal()`, `_backfill_plan()` | Core of the conversational flow; staleness guard and waterfront guard here; temp=0 seed=42 for determinism |
| `backend-py/app/services/jobs.py` | Analysis orchestrator | `_run_analysis()`, `start_job()`, `_buildability_flags()`, `_cap_competition_whitespace()` | Longest file (~1250 lines); manages all spatial pipeline stages; `QueryTracker` wired here |
| `backend-py/app/services/prompts.py` | LLM system prompt | `chat_system_prompt()` | ~500 lines; P7 "not_feasible" example must stay corrected (rent→tradeoffs, not not_feasible) |
| `backend-py/app/services/critic.py` | Post-exec self-critique | `critique_analysis()` | Lazy `AsyncOpenAI` import (not module-level) — required for import-without-openai in tests |
| `backend-py/app/services/storage.py` | GCS persistence | `put_json()`, `get_json()`, `cache_key()` | All fail-soft; app works without GCS |
| `backend-py/app/engine/intent_parser.py` | Deterministic parser | `parse_raw_intent()`, `_COUNT_RE`, `_BIZ_PATTERNS`, `detect_contradictory_constraints()` | Only 2 patterns match supermarket — add more if other large-format terms emerge |
| `backend-py/app/engine/canonical_archetypes.py` | Frozen factor schemas | `_DEFAULT_OSM_TAGS`, `_DEFAULT_PLACES_TYPES`, `to_layers_dict()`, `resolve_canonical_archetype()`, `detect_student_qsr()` | Default tags in `to_layers_dict()` are CRITICAL — without them specValid=False and run button disappears |
| `backend-py/app/engine/deterministic_planner.py` | Override LLM structure | `apply_deterministic_plan()`, `planning_fingerprint()`, `spec_fingerprint()` | Fingerprint changes with ENGINE_VERSION — expected and documented |
| `backend-py/app/engine/study_area.py` | Geocoding + AOI | `geocode()`, `resolve_study_area()`, `reverse_geocode_name()` | Google first, Nominatim fallback; India bias in both |
| `backend-py/app/engine/grid.py` | H3 hex grid | `polyfill()`, `HexCell`, `cell_boundary()`, `hex_distance_rings()` | Auto-degrades resolution if >8000 hexes |
| `backend-py/app/engine/data_osm.py` | Overpass fetch | `fetch_all_layers()`, `fetch_layer_pois()`, `fetch_area_geometries()`, `fetch_line_geometries()` | 3 endpoints, 50s timeout each; client-side classification of union query results |
| `backend-py/app/engine/data_places.py` | Google Places fetch | `fetch_places_pois()` | Sample grid; max 25 points; 2 pages; dedup by place_id |
| `backend-py/app/engine/scoring.py` | MCDA core | `pass_a()`, `composite_for_hex()`, `fit_normalization()`, `normalize()`, `select_candidates()`, `refit_refined_layers()` | `present_weight` renormalization is key honesty mechanism |
| `backend-py/app/engine/results.py` | Output building | `build_location()`, `write_explanations()`, `build_hex_grid()`, `build_catchments()`, `disambiguate_names()` | Lazy `AsyncOpenAI` import (not module-level) — required for tests |
| `backend-py/app/engine/water.py` | Water masking | `water_mask()`, `water_overlap_mask()`, `build_water_polygons()` | Handles both closed-way ponds and relation-member open fragments |
| `backend-py/app/engine/buildability.py` | No-build masks | `centroid_in_polygon_mask()`, `line_buffer_mask()`, `point_buffer_mask()`, `commercial_viability()` | Tags defined as module-level constants; PROTECTED_AREA_TAGS is long list |
| `backend-py/app/engine/corridors.py` | Linear gates | `distance_to_lines_m()`, `corridor_mask()` | Local equirectangular projection — accurate at city scale only |
| `backend-py/app/engine/catchments.py` | Isochrone fetch | `fetch_isochrones()`, `_google_isochrone()`, `_ors_isochrone_batch()`, `_rate_limit()` | Google Routes primary (v1.4+); `_rate_limit` alias preserved for routing.py |
| `backend-py/app/engine/routing.py` | ORS route constraints | `evaluate_route_constraint()`, `fetch_railway_lines()` | Per-candidate ORS Directions; railway-crossing detection |
| `backend-py/app/engine/traffic.py` | Drive-time demand | `traffic_catchment()`, `typical_peak_departure()` | Google Routes Matrix; fixed 18:00 IST weekday; GCS-cached |
| `backend-py/app/engine/multi_score.py` | R/V/C scoring | `compute_multi_scores()`, `determine_recommendation_status()`, `compute_confidence_score()` | Thresholds hardcoded — future work: move to CanonicalArchetype |
| `backend-py/app/engine/evidence_builder.py` | Evidence assembly | `QueryTracker`, `assemble_evidence_trail()`, `build_factor_evidence()`, `build_exclusion_ledger()` | `_scrub_secrets()` is the security boundary |
| `backend-py/app/engine/poi_merge.py` | OSM+Places dedup | `merge_pois()`, `osm_tags_for_places()`, `places_type_for_osm()` | Spatial dedup at ~40m threshold |
| `backend-py/app/engine/uploaded_candidates.py` | CSV point scoring | `validate_uploaded_points()`, `score_uploaded_points()`, `build_no_points_result()` | Hard gate: no CSV + uploadedCandidatesOnly=True → blocks execution |
| `src/App.tsx` | Root component | `handleChatTurn()`, `handleConfirmExecute()`, `handleRunAnalysis()`, PDF export IIFE, `handleNewChat()` | Largest file (~1300 lines); manages all cross-component state |
| `src/components/FloatingAssistant.tsx` | Chat UI | `handleSubmit()`, `handleCopyMessage()`, `handleEditMessage()`, `handleSharePrompt()` | Sector picker removed in v1.4, reverted in v1.3 rollback |
| `src/components/SpecSummaryCard.tsx` | Plan card | `▶ Start analysis` button (readyToExecute && !blocked) | If specValid=False, chatReady=False and this button never appears |
| `src/components/ResultsDrawer.tsx` | Results panel | Evidence Trail section, criteria chart, location cards | Evidence trail renders if `evidenceTrail` present; "unavailable" otherwise |
| `src/components/MapView.tsx` | Leaflet map | `rampColor()`, `getMarkerIcon()`, hex grid layers, catchment overlays, AOI boundary | Uses global `L` (CDN Leaflet); no npm package |
| `src/components/GuidedTour.tsx` | Onboarding tour | `isTourFirstVisit()`, `markTourSeen()`, responsive positioning | Auto-start for new non-admin users; localStorage flag |
| `src/contexts/AuthContext.tsx` | Firebase auth | `buildAuthUser()`, `consumePrompt()`, `signInWithEmail()` | Admin check: `ADMIN_EMAILS` list in firebase.ts |
| `src/contexts/SessionContext.tsx` | Session/memory | `addMessage()`, `updateMemory()`, `newSession()`, `switchSession()` | Session state persists in React memory only (no Firestore between page loads) |
| `src/services/chatService.ts` | API client | `sendChatTurn()`, `startAnalysis()`, `pollAnalysis()` | X-App-Token header from `config.appToken` (baked into build) |
| `src/types/index.ts` | TypeScript types | All frontend interfaces | Wire contract with backend JSON; field names must match exactly |

---

*End of document. Total source files inspected: ~38 backend files, ~16 frontend files, ~3 config/workflow files.*
