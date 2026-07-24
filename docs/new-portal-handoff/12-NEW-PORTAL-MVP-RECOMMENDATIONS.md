# 12 — New Portal MVP Recommendations

Read `00`–`11` first. This file proposes the minimal boundary for a clean,
independent, **LLM-led MCDA** portal, and lists the behavioural invariants the
new engine must enforce.

## Behavioural invariants (preserve these — cite the current implementation)

The new portal may change *who decides* the methodology, but it must keep these
rules. Each cites the current code + test.

| # | Invariant | Current code | Current test |
|---|-----------|--------------|--------------|
| I1 | Missing data is never scored as zero (excluded from num + denom) | `scoring.pass_a`, `composite_for_hex`, `present_weight` | `test_scoring.py` |
| I2 | A hard constraint is a gate, not a weighted factor | corridors/exclusions/routes are masks, never `layers` (`jobs.py`) | `test_corridors.py`, `test_hard_constraint_visibility.py` |
| I3 | A route requirement cannot pass without route evidence (unavailable ≠ pass) | `passes_required_routes`, route-metric handling in `jobs.py` | `test_v14_reliability.py` |
| I4 | Rent / floor area / availability / zoning / ownership are unverifiable at screening — disclosed, never claimed passed | `constraint_policy.py`, `screening_contract` next-validation | `test_vnext_contract.py` |
| I5 | Exact property availability is never claimed; H3 centroids are zones, not premises | `results.siteClaimLevel`, centroid wording (map/cards/PDF) | `test_vnext_contract.py` (claim level) |
| I6 | Water/unbuildable cells cannot be recommended | `water.py`, baseline mask in `jobs.py` | `test_water.py`, `test_v162_smart_masks.py` |
| I7 | Weights sum to one (present-weight renormalized) | `SpecV2` renorm, `present_weight` | `test_spec.py`, `test_scoring.py` |
| I8 | Provider failure differs from observed zero | `LayerScores.data_status`, `results.build_location` | `test_vnext_contract.py` (observed absence) |
| I9 | An unavailable **required** factor withholds ranking | `required_missing_layers` + gate in `jobs.py` | `test_v14_reliability.py` |
| I10 | LLM narrative cannot change deterministic ranks | `results.write_explanations` (prose only), scoring is pure | (structural) |
| I11 | Unverified requirements become next-validation actions | `screening_contract.build_zone_next_validation` | `test_vnext_contract.py` |
| I12 | Competition can be "less but not zero" (target band), not monotonic | `scoring.curve_score`, `detect_competition_band` | `test_vnext_contract.py` (target band) |
| I13 | No raw exception reaches the user (three-state result) | `jobs._failed_result`, `_run_in_thread` | `test_v146_degradation.py`, `test_job_lifecycle.py` |
| I14 | Reweight-promoted zones don't inherit verification evidence | screening-basis pins + NEW—UNVERIFIED (frontend) | `reweighting.test.ts`, `screeningPresentation.test.ts` |
| I15 | Same normalized brief → stable methodology (reproducibility) | today via fingerprints; **new portal must achieve this with LLM temp=0/seed + schema validation** | `test_v164_map_and_coords.py` |

**I15 is the hard one for an LLM-led portal.** The current portal gets
reproducibility for free from the deterministic registry. The new portal must
engineer it: low-temperature/seeded planning, a strict validated schema, and a
cache keyed on the normalized prompt so the same brief resolves to the same
methodology.

## Proposed minimal boundary

### LLM responsibilities
- Interpret the brief; hold the consultative chat; write the reply and
  per-zone explanations.
- **Design the MCDA methodology:** choose factors, weights, directions,
  catchments, scoring curves (incl. target-band), and propose hard
  constraints — emitted as a **strict, validated methodology spec**.
- Classify business type, spatial scale, and unverifiable requirements.

### Deterministic engine responsibilities
- **Validate** the LLM spec against a typed schema (reject/repair; enforce I1,
  I2, I7 structurally — constraints and factors are different types).
- Resolve study area → H3 grid → provider fetch → Pass A → masks → candidate
  selection → Pass B refinement → final composite → confidence → verdicts →
  next-validation. **Ranking is pure arithmetic.**
- Enforce every invariant I1–I14 in code, not by trusting the LLM.

### MVP features
- Conversational planning → reviewable plan → execute → poll → investigation
  zones.
- Two-pass MCDA (Euclidean screening + isochrone/real-catchment refinement).
- Baseline unbuildable-land + water masks; named + coordinate exclusions.
- Screening verdicts, per-zone evidence + key risk + next-validation.
- One conservative confidence verdict.
- Observed / observed-zero / unavailable data status.
- Target-band competition.
- Interactive map with investigation-zone-centroid wording.
- Three-state result contract + graceful provider degradation.

### Non-features (MVP)
- Firebase auth, quotas, admin, usage tracking.
- PDF report, saved/shared analyses, multi-session memory.
- Client-side reweighting + verify-shortlist (add after core value is proven).
- Metro static lists, ghat/heritage/railway context masks, traffic-aware
  routing, custom-layer sandbox, GCS snapshot restore.
- Model routing/escalation/fallback tiers.

### Providers (MVP)
OpenAI (planning + explanations), Overpass/OSM (POIs + geometry), Google Places
New (competition/footfall corroboration), a routing provider for real
catchments (ORS or equivalent), Google/Nominatim geocoding, Carto basemap
tiles. Later: Google Routes (traffic), Places Aggregate, Place Details.

### Core contracts (define fresh, lean)
- `MethodologySpec` (LLM output): study area, factors[`{name, weight,
  direction, source, catchment, scoringCurve, required}`], constraints[typed],
  output settings. Drop all determinism-fingerprint fields.
- `AnalysisResult`: three-state; `zones[]` with `{name, lat, lng, score,
  screeningVerdict, criteria[], nextValidation[], excluded, reasoning,
  scoreWithheld}`; `hexGrid[]`; `confidence`; `dataCoverage`; `claimLevel`.
- `JobStatus`: `{status, progress, phase, message, result?}`.

### Suggested repository structure
```text
new-portal/
  frontend/            # React + Vite (Vercel)
    src/services/      # api client, presentation projections (extract 09)
    src/components/    # map, results, plan card (rewrite around new contract)
  backend/             # FastAPI (Cloud Run)
    app/planner/       # LLM methodology design + schema validation (NEW)
    app/engine/        # scoring, grid, masks, providers (EXTRACT from 09)
    app/orchestrator/  # clean job runner (rewrite of jobs.py)
    app/models/        # lean MethodologySpec + AnalysisResult
    tests/             # ported subset (11) + property-based prompt scenarios
```

### Suggested independent deployment
Vercel (frontend) + Cloud Run (backend), new repo, new Secret Manager, new
provider keys, new billing project. Keep `--max-instances 1
--no-cpu-throttling` for the in-memory job store. Backend-first deploy + `/health`
verify + rollback tag discipline (see `08`).

## Open design decisions (for the next session to resolve)

1. **Reproducibility (I15):** temperature-0 + seed + normalized-prompt cache,
   or a hybrid where the LLM picks from a validated factor *vocabulary* the
   engine owns (a middle ground between full-registry and full-LLM)?
2. **How strict is factor validation?** Free-form LLM factors vs a curated
   source/tag catalog the LLM must map onto (affects OSM/Places query safety).
3. **Auth for MVP:** open demo with the `X-App-Token` kill-switch only, or a
   light auth from day one?
4. **Constraint model:** one unified typed constraint (I2/I4) — how to
   represent screening vs detailed-validation stage in the schema.
5. **Catchment provider:** ORS vs Google Routes vs a self-hosted OSRM for cost
   control.
6. **Confidence inputs:** what feeds the conservative merge without the current
   `dataSufficiencyV2` + LLM-critic machinery.
7. **Persistence:** stay stateless for MVP, or add a minimal store for
   share links early?

---

**Do not implement the new portal in this task.** This package is the input to
that work.
