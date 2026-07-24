# 02 — End-to-End Execution Flow

Legend for stage type: **[LLM]** LLM-controlled · **[DET]** deterministic ·
**[PROV]** provider-dependent · **[USER]** user-editable · **[ASYNC]**
asynchronous/polled · **[OPT]** optional (planner-gated or degradable).

## Full flow

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend (App.tsx)
    participant Chat as POST /api/v2/chat
    participant LLM as OpenAI (gpt-5.4-mini)
    participant DP as deterministic_planner
    participant An as POST /api/v2/analyses
    participant Job as jobs._run_analysis (thread)
    participant Geo as study_area (geocode)
    participant Grid as grid.polyfill (H3)
    participant Prov as OSM / Places / ORS / Routes
    participant Score as scoring (Pass A/B)
    participant Res as results + screening_contract
    participant Norm as resultNormalizer
    participant UI as ResultsDrawer + MapView

    User->>FE: enters prompt [USER]
    FE->>Chat: messages + draft spec [USER]
    Chat->>LLM: system prompt + history [LLM]
    LLM-->>Chat: reply + draft spec (factors, study area) [LLM]
    Chat->>DP: apply_deterministic_plan(llm_spec, intent, canonical) [DET]
    Note over DP: OVERRIDES factors/weights/catchments/curves/constraints<br/>from canonical_archetypes registry.<br/>LLM keeps: study-area places, explanation text.<br/>Parsers add: prompt weights, exclusions, coords, radius, target-band.
    DP-->>Chat: validated SpecV2 + plannerPreview [DET]
    Chat-->>FE: reply, spec, stage(chat/framework/ready) [DET]
    FE->>User: plan card (SpecSummaryCard) [USER]
    User->>FE: adjust weights / grid, then "Run" [USER]
    FE->>An: { spec } (+ Firebase token) [USER]
    An->>An: feasibility gate, layer repair, SpecV2 validate, quota consume [DET]
    An-->>FE: { jobId } [ASYNC]
    An->>Job: start_job(spec) -> thread [ASYNC]

    loop poll every 2.5s [ASYNC]
        FE->>An: GET /analyses/{jobId}
        An-->>FE: { status, progress, message, result? }
    end

    Job->>Geo: resolve_study_area [PROV] Google->Nominatim
    Geo-->>Job: polygon + bbox
    Job->>DP: create_analysis_plan (relevance gate) [DET] which stages run
    Job->>Grid: polyfill(polygon, resolution) [DET]
    Grid-->>Job: hexes
    Job->>Prov: fetch_all_layers (OSM union) + Places [PROV][OPT] bounded, degradable
    Prov-->>Job: POIs per layer (or observed_zero / unavailable)
    Job->>Score: pass_a (Euclidean BallTree counts, normalize, curve, composite) [DET]
    Job->>Job: exclusion mask + baseline land-cover mask [PROV][DET]
    Job->>Job: water mask, corridors, named/coord exclusions, buildability [PROV][OPT]
    Job->>Score: select_candidates (top-K, H3 ring separation) [DET]
    Job->>Prov: Pass B — isochrones / Places Aggregate / traffic / routes [PROV][OPT] top-K only
    Job->>Score: refit_refined_layers + composite_for_hex (final rank) [DET]
    Job->>Res: build_location per zone, reverse-geocode names [PROV]
    Job->>Res: constraint_policy, deterministic critic, unified_confidence [DET]
    Job->>Res: apply_screening_verdicts + build_zone_next_validation [DET]
    Res-->>Job: full result payload (three-state contract)
    Job-->>An: job.result = { status, candidates, hexGrid, ... }
    FE->>Norm: normalizeAnalysisResult(result) [DET] repair/sanitize
    Norm-->>UI: rendered investigation zones [USER]
    UI->>User: Investigation zones rendered
```

### Stage annotations

- **LLM-controlled:** the chat reply text, the *initial* factor/study-area
  extraction, and per-candidate explanation prose. Nothing the LLM emits
  reaches the final score after the deterministic override.
- **Deterministic:** planning override, validation, grid, scoring,
  normalization, curves, masks (logic), candidate selection, confidence,
  verdicts, next-validation. **This is where ranking is decided.**
- **Provider-dependent:** geocode, OSM/Places fetch, isochrones, Google
  Routes, reverse geocode. All bounded + degradable.
- **User-editable:** the prompt, weight sliders, grid-level picker, the "Run"
  confirmation, post-run reweighting.
- **Asynchronous:** job creation returns a `jobId` immediately; the frontend
  polls every 2.5 s until a terminal status.
- **Optional / planner-gated:** water geometry, buildability sub-checks,
  routing, isochrone refinement, Places Aggregate, traffic, place details —
  each runs only when relevant and degrades to a labeled fallback on failure.

## Essential spatial-analysis core (simplified)

Strip the LLM chat, deterministic override, auth, PDF, sessions, and evidence
trail, and the irreducible engine is:

```mermaid
flowchart TD
    A[Spec: study area + weighted factors + constraints] --> B[Resolve study area to polygon]
    B --> C[H3 polyfill to grid cells]
    C --> D[Fetch POIs per factor: OSM + Places]
    D --> E[Pass A: Euclidean counts to normalized 0-1 to weighted composite]
    E --> F[Apply masks: water + land-cover + exclusions + corridors]
    F --> G[Select top-K candidates with H3 ring separation]
    G --> H[Pass B: isochrone / routing / traffic refinement of top-K]
    H --> I[Refit refined-layer normalization + final composite rank]
    I --> J[Confidence + per-zone verdict + next-validation]
    J --> K[Investigation zones]
```

Everything else in the current portal wraps this core. A new LLM-led portal
needs **this core plus an LLM planner that emits the input spec** — and does
not need the hardcoded archetype registry that currently sits between the LLM
and this core.
