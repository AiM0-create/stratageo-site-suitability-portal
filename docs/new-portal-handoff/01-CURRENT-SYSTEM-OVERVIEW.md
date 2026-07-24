# 01 — Current System Overview

## What the product does

A conversational, screening-grade site-suitability portal for India. The user
describes a business and geography in natural language; the portal holds a
short consultative chat, produces a reviewable analysis plan, executes a
spatial MCDA screening, and returns ranked **investigation zones** (H3
hexagons, never exact parcels) with:

- per-factor scores + the evidence behind each (OSM / Google Places / ORS /
  Google Routes);
- hard constraints enforced as real spatial pass/fail gates;
- one conservative headline confidence verdict;
- per-zone screening verdict (Priority / Promising / Conditional / Low
  priority / Withheld) and next-stage validation actions;
- an interactive map, a PDF report, and shareable/saved analyses.

Stack: **React 19 + TypeScript + Vite** frontend (static SPA on GitHub Pages),
**FastAPI + Python 3.12** backend on **Google Cloud Run**, **Firebase
Auth/Firestore** for identity + saved analyses.

## Frontend module map

Entry: `src/main.tsx` → `src/App.tsx` (~2,000-line orchestrator; holds the
analysis state machine). Routing is hash-based inside `App.tsx` (no router
library); the only "route" is `#/share/:id`.

| Path | Responsibility | Reuse concept? | Copy code? |
|------|----------------|----------------|-----------|
| `src/App.tsx` | State machine (idle→planning→spec_ready→executing→completed/failed), chat turn, execute, poll, cancel, retry, reweight, PDF export, session cache | Yes (state machine) | No — too coupled; rewrite |
| `src/services/chatService.ts` | HTTP client for `/api/v2/chat`, `/analyses`, poll, cancel; typed errors; watchdog | Yes | Reference — thin, cleanly isolated; adapt to new API |
| `src/services/analysisFlow.ts` | Pure follow-up/confirmation classification helpers | Yes | Reference |
| `src/services/resultNormalizer.ts` | Repairs/sanitizes every backend result before render; records `normalizationWarnings` | Yes (boundary-repair pattern) | No — tied to legacy payload; rewrite smaller |
| `src/services/mcdaEngine.ts` | **Client-side** reweighting, hex recolor, grid ranking, top-X screening selection | Partial | Reference — reweight math only |
| `src/services/screeningPresentation.ts` | v1.8.0 pure projections: exec summary, evidence reasons, key risk, rank deltas, methodology comparison, CTA copy | Yes | **Extract** — cleanly isolated, well-tested |
| `src/services/mapFigure.ts` | Renders the PDF map figure over Carto tiles (Web Mercator, north arrow, scale bar, legend) | Yes | Reference — good, but PDF is not MVP |
| `src/services/analysisStore.ts` | Firestore save + shareId fetch | No | Do not copy (Firebase coupling) |
| `src/services/usageTracker.ts` | Prompt logging / admin analytics | No | Do not copy |
| `src/components/MapView.tsx` | Leaflet map: choropleth, AOI, pins, catchments, screening pins | Yes | Reference — Leaflet wiring reusable, data-binding rewrite |
| `src/components/ResultsDrawer.tsx` | The results presentation (~1,700 lines): exec header, zone cards, confidence, constraints, evidence trail, CTA | Yes (structure) | No — rewrite around new contract |
| `src/components/SpecSummaryCard.tsx` | Plan-card review: factors, weights, grid picker, planner preview | Yes | Reference |
| `src/components/MethodologyDialog.tsx` | Static methodology + contact CTA | Yes | Reference |
| `src/components/{LoginScreen,AdminDashboard,SavedAnalyses,PromptLimitModal,GuidedTour,TopBar,DiagnosticsPanel,FloatingAssistant,ErrorBoundary}.tsx` | Auth, admin, saved list, quota modal, tour, chrome | No / partial | ErrorBoundary reference; rest do not copy |
| `src/config/index.ts` | App config: backend URLs, app token, basemaps, sectors | Yes | Reference |
| `src/config/firebase.ts` | Firebase init + admin allowlist | No | Do not copy |
| `src/contexts/SessionContext.tsx` | Multi-session chat memory reducer | Partial | Reference — MVP may need only single session |
| `src/types/index.ts` | The full result/spec TypeScript contract (~640 lines) | Yes | Extract selectively (see 07) |
| `src/types/chat.ts`, `src/types/session.ts` | Chat + session types | Partial | Reference |

## Backend module map

Entry: `backend-py/app/main.py` (FastAPI app, CORS + `SecurityMiddleware`,
three routers). The orchestrator is `services/jobs.py`.

| Path | Responsibility | External providers | Recommendation |
|------|----------------|--------------------|----------------|
| `app/main.py` | App wiring, CORS, middleware order | — | Rewrite cleanly (trivial) |
| `app/routers/health.py` | `/health` capability + version report | — | Reference |
| `app/routers/chat.py` | `POST /api/v2/chat` planning turn; typed OpenAI error mapping | OpenAI | Reference (error mapping is valuable) |
| `app/routers/analyses.py` | Start/status/cancel/evidence endpoints; spec repair + validation; auth/quota hooks | — | Reference |
| `app/services/jobs.py` | **The orchestrator** (~2,760 lines): job store, threaded runner, per-call degradation, circuit breaker, the entire analysis pipeline, result assembly | OSM, Google, ORS | **Rewrite cleanly** — the pipeline sequence is the crown jewel, but it is monolithic and carries years of patches |
| `app/services/llm.py` | Chat turn: LLM call, deterministic-planner override, waterfront/corridor guards, follow-up signals | OpenAI | Reference — the guard logic is valuable; the override call is what the new portal replaces |
| `app/services/critic.py`, `app/engine/reliability_critic.py` | Post-execution self-critique (deterministic + optional LLM) | OpenAI (opt) | Reference (later) |
| `app/engine/canonical_archetypes.py` | **Hardcoded archetype registry** (factors/weights/catchments/curves per business type) | — | **Do not copy** — this is what the LLM replaces |
| `app/engine/deterministic_planner.py` | Overrides LLM spec with canonical schema; prompt parsers (weights, exclusions, coords, radius, target-band); fingerprints | — | Reference — the *parsers* are reusable ideas; the *override* is not |
| `app/engine/scoring.py` | Two-pass MCDA: BallTree counts, normalization, curve_score, composite, refit | — | **Extract** — clean, well-tested numeric core |
| `app/engine/contracts.py` | Numeric scoring contract (finite-float coercion, normalize_0_1 with curve) | — | **Extract** |
| `app/engine/results.py` | Maps engine output → frontend result shape; evidence wording; methodology text | OpenAI (explanations) | Rewrite around new contract |
| `app/engine/screening_contract.py` | v1.8.0 verdict/claim-level/next-validation projection | — | **Extract** (adapt) |
| `app/engine/planner_lite.py` | Per-prompt relevance gate (which stages run) + intelligence classification + spatial scale | — | Reference — good idea, tied to canonical archetypes |
| `app/engine/grid.py` | H3 polyfill, cell boundary, ring distance | — | **Extract** |
| `app/engine/study_area.py` | Geocode (Google→Nominatim), study-area polygon, reverse geocode | Google, Nominatim | **Extract** (adapt keys) |
| `app/engine/water.py` | Water masks (centroid-in-polygon + area-overlap) | — | **Extract** |
| `app/engine/buildability.py` | Land-cover masks (centroid/line/point buffers) + tag sets | — | **Extract** |
| `app/engine/corridors.py` | Distance-to-line corridor gates | — | **Extract** |
| `app/engine/catchments.py` | ORS isochrone fetch + POI-in-polygon counts | ORS | Extract (adapt) |
| `app/engine/routing.py`, `route_policy.py` | ORS/Google network route constraints + strict enforcement | ORS, Google Routes | Reference |
| `app/engine/traffic.py` | Google Routes traffic-aware drive catchments | Google Routes | Reference |
| `app/engine/metro.py` | Verified metro-station lists + exclusion detection | static data | Reference (later) |
| `app/engine/data_osm.py` | Overpass fetch (union query, mirror failover) | Overpass | **Extract** |
| `app/engine/data_places.py`, `poi_merge.py` | Google Places fetch + OSM/Places dedup merge | Google | Extract |
| `app/engine/unified_confidence.py` | Conservative-min confidence merge | — | **Extract** |
| `app/engine/constraint_policy.py` | Rent/floor/zoning/parcel/ownership unverifiable-constraint classification | — | Reference (ideas) |
| `app/engine/hard_constraints.py` | Per-requested-constraint verification status | — | Reference |
| `app/engine/evidence_builder.py`, `stability.py`, `multi_score.py`, `intent_parser.py`, `archetypes.py`, `sandbox.py`, `uploaded_candidates.py` | Evidence trail, scenario stability, multi-score, raw intent, playbook text, custom-layer sandbox, uploaded points | mixed | Mostly reference/later; sandbox do-not-copy |
| `app/providers/*` | Typed Google clients (Places New, Aggregate, Routes, Details) with budget/breaker | Google | Extract (Places New + Routes); Aggregate/Details later |
| `app/models/spec.py` | `SpecV2` and all sub-models (~680 lines) | — | Reference — new portal defines its own leaner spec |
| `app/models/chat.py`, `models/evidence.py` | Chat request/response, evidence models | — | Reference |
| `app/config.py` | Settings (env), version constants, model routing | — | Reference (env pattern) |
| `app/auth_quota.py`, `app/security.py` | Firebase auth + quota; rate-limit/size middleware | Firebase | Rate-limit reference; auth do-not-copy |
| `app/services/storage.py` | GCS job snapshot (currently `hasGcsBucket:false`) | GCS | Do not copy (MVP) |

## Documentation inventory

| Document | Status | Contributes | Conflicts found |
|----------|--------|-------------|-----------------|
| `README.md` | Current (v1.8.0) | Product positioning, highlights, version history, tech stack, env vars | None material |
| `CHANGELOG.md` | Current | Per-release detail incl. v1.8.0 contract | None |
| `docs/analysis-engine-v1.5-change-log.md` | Current | Numbered per-file engine change log through §74 | None |
| `docs/VNEXT_SCREENING_AND_INVESTIGATION_ZONE_AUDIT.md` | Current | v1.8.0 gap matrix + "already solved" list + invariants | None |
| `docs/VNEXT_MANUAL_SMOKE_TEST_GUIDE.md` | Current | The nine live prompts with expected wording | None |
| `docs/PHASE3-SECURITY-REVIEW.md` | Current | Auth/quota/rate-limit design | Auth is out of scope for new MVP |
| `docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md` | Aging (v1.5-era) | Architecture §8–§11 background | Predates v1.6–v1.8; verify against code |
| `docs/portal-current-state-audit-v1.5.md`, `portal-framework-walkthrough.md`, `STRATAGEO_CURRENT_FRAMEWORK_AND_CODE_WALKTHROUGH.md` | Aging | Historical framework detail | Predates target-band/screening-contract |
| `docs/STRATAGEO_V1_4_KNOWN_LIMITATIONS.md` | Aging | Known-limitations background | Some resolved since v1.4 |
| `docs/LIVE_PORTAL_QA_FINDINGS.md` | Aging | QA findings P1-4/5/6 (still open) | Informational |
| `docs/archive/**` | **Archived — not authoritative** | Version history only | Do not treat as current |

**Rule applied throughout:** where an aging doc and the code disagree, the
code at `ecd4c58` wins and the disagreement is noted in the relevant handoff
section.
