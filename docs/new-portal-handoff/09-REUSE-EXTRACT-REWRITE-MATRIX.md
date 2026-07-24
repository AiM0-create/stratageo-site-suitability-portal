# 09 — Reuse vs Rewrite Matrix

Two lists: **code you can copy with light changes**, and **ideas worth keeping
whose current code should be rewritten**.

## Code potentially reusable (extract)

Only modules that are reasonably isolated, tested, not coupled to old
auth/session/result models, and safe to copy.

| Source path | Functions/classes | Dependencies | Tests | Changes before reuse | Coupling | Recommendation |
|-------------|-------------------|--------------|-------|----------------------|----------|----------------|
| `engine/scoring.py` | `pass_a`, `normalize`, `curve_score`, `tx`, `fit_normalization`, `composite_for_hex`, `select_candidates`, `refit_refined_layers`, `LayerScores` | numpy, sklearn BallTree, `models.spec.Layer`, `contracts` | `test_scoring.py`, `test_vnext_contract.py` | Depend on a `Layer`-shaped object; swap in the new spec type | Low | **Extract** |
| `engine/contracts.py` | `to_finite_float`, `normalize_0_1`, `aggregate_provider_values`, `FactorResult` | stdlib | `test_v147_contract.py` | None material | Very low | **Extract** |
| `engine/grid.py` | `polyfill`, `cell_boundary`, `hex_distance_rings` | h3-py, Shapely | (via scoring/results tests) | None | Very low | **Extract** |
| `engine/water.py` | `water_mask`, `water_overlap_mask` | numpy, Shapely | `test_water.py`, `test_water_tag_hotfix.py` | None | Low | **Extract** |
| `engine/buildability.py` | `centroid_in_polygon_mask`, `line_buffer_mask`, `point_buffer_mask`, tag constants | numpy, Shapely | `test_buildability.py`, `test_v162_smart_masks.py` | None | Low | **Extract** |
| `engine/corridors.py` | `distance_to_lines_m`, `corridor_mask` | numpy, Shapely | `test_corridors.py` | None | Low | **Extract** |
| `engine/data_osm.py` | `fetch_all_layers`, `fetch_area_geometries`, `fetch_line_geometries`, `fetch_named_features` | httpx, Overpass | (integration) | New timeout/config wiring | Low | **Extract** |
| `engine/unified_confidence.py` | `build_unified_confidence` | stdlib | `test_v160_phase3.py` | Feed it the new sufficiency/critic dicts | Very low | **Extract** |
| `engine/screening_contract.py` | `apply_screening_verdicts`, `build_zone_next_validation`, `claim_level`, `sparse_competition_factor_names` | stdlib | `test_vnext_contract.py` | Verdict source is `investigationLabel` today — adapt to the new label/verdict source | Low–med | **Extract (adapt)** |
| `engine/study_area.py` | `resolve_study_area`, `geocode`, `reverse_geocode_name` | httpx, Shapely, Google/Nominatim | (integration) | New keys; keep the coarse-match rejection guard | Med (provider) | **Extract (adapt)** |
| `engine/catchments.py` | `fetch_isochrones`, `count_pois_in_polygon` | httpx, ORS, Shapely | `test_routing.py` (partial) | New ORS key/config | Med | Extract (adapt) |
| `providers/google_places_new.py`, `providers/base.py` | `fetch_pois_with_fallback`, `ProviderBudget`, breaker | httpx | `test_v148_google_providers.py` | New key/config | Med | Extract (Places New + budget/breaker) |
| `src/services/screeningPresentation.ts` | exec summary, reasons, risk, deltas, comparison, copy summary | types only | `screeningPresentation.test.ts` | New result type | Low | **Extract** |
| `src/services/mcdaEngine.ts` (reweight only) | `recalculateWithWeights`, `reweightHexGrid`, `weightsDiffer`, `computeGridRanks` | types only | `reweighting.test.ts` | New types | Low | Extract (reweight math) |
| `src/services/chatService.ts` | HTTP client + poll + typed errors + watchdog | fetch, firebase (lazy) | — | Drop firebase import; new API | Low–med | Reference/extract |

## Ideas to reimplement cleanly (do NOT copy the code)

| Idea | Why keep it | Why rewrite (not copy) |
|------|-------------|------------------------|
| **Missing-data semantics** (observed / observed_zero / unavailable / required-withhold) | The honesty spine of the product | Currently threaded through `jobs.py` (2,760 lines) + `scoring` + `results` — extract the *rule*, implement in a clean small module |
| **Target-band competition** | Correct competition modelling | The math is tiny (`04`); reimplement from the formula, not the call-site plumbing |
| **H3 candidate separation** | Avoids near-duplicate zones | `select_candidates` is clean-ish but tied to `LayerScores`; reimplement over the new candidate type |
| **Screening-vs-refined distinction** | Honest "map colour ≠ final rank" | Currently smeared across scoring + results + drawer; encode it as one explicit field pair in the new contract |
| **Constraint/factor separation** | A gate is not a weighted factor | The current split works but is enforced by convention across many files; make it a *schema* rule (constraints and factors are different types) |
| **Conservative confidence merge** | One defensible headline number | `unified_confidence.py` is extractable, but the *inputs* (dataSufficiencyV2, critic) are legacy-shaped; rebuild the inputs cleanly |
| **Investigation-zone terminology + centroid wording** | Product honesty | Reimplement as copy constants + a `claimLevel` type; don't inherit the scattered strings |
| **Next-validation generation** | Every limitation → an action | `screening_contract.build_zone_next_validation` is a good template but keyed to the current unsupported-constraint vocabulary; regenerate for the new constraint model |
| **Deterministic prompt parsers** (weights, coords, radius, exclusions) | Deterministic structure the LLM shouldn't own | In an LLM-led portal these may become LLM outputs *validated* by regex, not regex-primary; reimplement as validators |
| **Provider degradation + circuit breaker** | Slow provider must not kill a job | `jobs._degradable_call` + `ProviderBreaker` are good patterns; reimplement as a small reusable wrapper, not the in-line job plumbing |
| **Three-state result contract** | No raw exception reaches the user | Reimplement as a typed result union from day one |
| **Free-flow honesty label** | Don't overstate reach | Reimplement as a catchment-label helper |

## Rule of thumb for the next session

**Extract** the pure spatial/numeric modules (scoring, grid, masks, contracts,
confidence, providers) — they are isolated and tested. **Rewrite** everything
that touches the result payload, the job orchestrator, the archetype override,
auth, sessions, and the UI — those carry the historical complexity and the old
contracts.
