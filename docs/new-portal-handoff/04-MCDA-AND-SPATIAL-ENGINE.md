# 04 — MCDA and Spatial Engine

Source of truth: `backend-py/app/engine/scoring.py`, `contracts.py`,
`results.py`, `grid.py`, `models/spec.py`. All formulas below match the code at
`ecd4c58`.

## Factor (layer) representation

A factor is a `Layer` (`models/spec.py`). Fields:

| Field | Req | Meaning |
|-------|-----|---------|
| `id`, `name` | yes | machine id + display name |
| `weight` | yes | positive; renormalized to sum 1 at spec level (`SpecV2.validate` divides by total) |
| `direction` | yes | `positive` (more = better) or `negative` (more = worse, inverted) |
| `source` | yes | discriminated union: `OsmSource{tags[]}` \| `PlacesSource{types[],keyword}` \| `CustomSource{code,inputLayerIds}` |
| `catchment` | yes | `Catchment{type: euclidean\|walk\|drive, meters?, minutes?, trafficAware}` |
| `normalization` | opt | `Normalization{method, pLow, pHigh}` — default `log_percentile`, 5, 95 |
| `scoringCurve` | opt | **v1.8.0** `monotonic` (default) \| `target_band` |
| `confidence` | opt | `high\|medium\|low` |
| `whyItMatters`, `proxyWarning`, `notes` | opt | consultant honesty text |
| `required` | opt | hard-constraint layer — missing data withholds ranking |

Provider queries: OSM factors carry Overpass tag strings; Places factors carry
Google place types + optional keyword. Custom factors run user code in a
sandbox over other layers' POIs (sandbox off by default — do not port).

## Raw-value generation (`scoring.pass_a`, `catchments.py`, `traffic.py`)

Raw value = count of that factor's POIs reachable from a hex, by catchment
type:

- **Euclidean:** `count_within(BallTree, hexes, radius_m)` — haversine
  ball-tree radius query. `radius = c.meters`.
- **Walk / drive (Pass A proxy):** radius = `minutes × walk_speed_m_per_min`
  (80 m/min) or `× drive_speed_m_per_min` (400 m/min) — a labeled Euclidean
  proxy, refined in Pass B.
- **Walk / drive (Pass B refinement):** true **ORS isochrone** polygon;
  `count_pois_in_polygon(poly, pois)`.
- **Google Places factors:** POIs from Places New (with legacy + OSM
  supplement merge, `poi_merge.merge_pois`); optionally refined by **Places
  Aggregate** authoritative count within a circle ≈ catchment.
- **Traffic-aware drive:** **Google Routes** typical-traffic reachable-count
  within `minutes` (`traffic.traffic_catchment`), replacing the isochrone
  count for `trafficAware` layers.
- **Route constraints:** not a factor — a per-candidate pass/fail gate via ORS
  Directions (`routing.evaluate_route_constraint`), distance/time + railway
  crossing.
- **Corridors:** not a factor — a distance-to-line mask
  (`corridors.distance_to_lines_m` + `corridor_mask`).

Raw counts are **stored and displayed untransformed**; only the scoring path
transforms them.

## Normalization (`scoring.fit_normalization`, `normalize`, `tx`)

"Scoring Standard v1" (v1.7.0, test-locked as a pre-launch decision):

1. **Transform** `tx(layer, v)`: if `normalization.method == "log_percentile"`
   (the default), `v ← log1p(v)`. Applied identically at fit and score time.
   Raw counts never transformed for display. Defensive: a poisoned
   (list/NaN) value passes through untransformed so the numeric contract owns
   degradation.
2. **Fit bounds:** `lo = percentile(tx(values), pLow=5)`,
   `hi = percentile(tx(values), pHigh=95)` (or min/max for `minmax`). Guard:
   if `hi <= lo`, `hi = lo + 1`.
3. **Normalize to [0,1]:** `x = clip((tx(v) − lo)/(hi − lo), 0, 1)`.
4. **Direction:** `negative` → `1 − x`; `positive` → `x`.

Rationale: urban POI counts are heavy-tailed (roughly log-normal); linear
stretching flattens the mid-range where siting decisions live. Ordering is
always preserved; only exaggeration is removed.

**Candidate refit** (`refit_refined_layers`): Pass-B/traffic values live on a
different scale than the Pass-A Euclidean grid. After refinement, each refined
layer's normalization is refit on its *refined candidate values* (spread-aware:
near-identical values compress toward neutral 0.5 rather than being forced to
0/10). A layer that is constant across candidates is flagged
`discriminating=False` and scores a neutral 0.5 (never a fabricated 0).

## Weighted composite (`scoring.composite_for_hex`, `present_weight`)

```text
present_weight = Σ weight[layer] for layers WITH data
composite      = ( Σ weight[layer] × curve_score(layer, tx(raw), lo, hi) ) / present_weight
                 over layers WITH data only
```

- **Missing factors are excluded from BOTH numerator and denominator** — never
  scored 0 (positive) or 10 (negative). If *no* layer has data,
  `composite_for_hex` returns `None` and the composite is withheld.
- **Weights sum to 1** after `SpecV2` renormalization; the composite is the
  present-weight-renormalized weighted mean.
- **User-adjusted weights:** re-ranked/recolored client-side
  (`mcdaEngine.recalculateWithWeights`, `reweightHexGrid`) with the same
  present-weight exclusion rule; the backend preserves user weights across
  turns (`preserve_user_weights`).

## Target-band scoring (v1.8.0 — `scoring.curve_score`, `contracts.normalize_0_1`)

Activation: `Layer.scoringCurve == "target_band"`, set deterministically by
`deterministic_planner.detect_competition_band` when the prompt says "less
competition but **not zero**" (canonical Kolkata prompt). Scoped to
competition-family layers only.

Formula over the normalized position `x ∈ [0,1]` (same `x` the monotonic path
uses, so log-space is inherited):

```text
peak = 0.35  (TARGET_BAND_PEAK)
score = 1 − |x − peak| / max(peak, 1 − peak)
```

- Optimum: `x = 0.35` → score 1.0 (moderate competitive presence).
- Zero observed (`x = 0`) → score ≈ 0.46 (**not** ideal).
- Saturation (`x = 1`) → score 0.0 (worst).
- **Direction is ignored** for target-band ("moderate is best" has no
  monotonic direction).
- Applied in three places that must agree: Pass A composite
  (`pass_a` via `curve_score`), per-hex refined scoring
  (`_layer_norm_for_hex` via `normalize_0_1(curve=…)`), and the per-cell map
  layer scores (`results.build_hex_grid`).

Difference from monotonic negative competition: a monotonic negative factor
gives the **best** score to zero observed competitors; target-band gives zero a
mid-low score and rewards moderate presence. Known modelling assumption: band
bounds are relative to the observed distribution (percentile position), never
an absolute competitor count.

## Missing-data semantics (v1.8.0 — `LayerScores.data_status`, `results.build_location`)

Six distinct states, all disclosed, none scored as a fabricated value:

| State | Meaning | Scoring effect | Wording |
|-------|---------|----------------|---------|
| `observed` | query OK, features found | scored normally | normal justification |
| `observed_zero` | query OK, **zero** features | excluded from composite | "queried successfully but found ZERO features … validate locally" — evidence basis `observed-zero` |
| `unavailable` | provider failed/timed out | excluded from composite | "provider failed … treat as unknown, not absent" — evidence basis `insufficient-data` |
| skipped / not-applicable | planner deemed stage irrelevant | not run | recorded in `analysisCompleteness.skippedStages` (no confidence hit) |
| weak proxy | low-confidence factor | scored, flagged | `lowConfidenceProxy=true` + `proxyWarning` |
| required unavailable | a `required` layer has no data | **ranking withheld**, all candidates excluded | `dataSufficiency.status = insufficient` |

`data_status` is resolved from actual fetch outcomes in `jobs.py` (main-OSM
failure / Places `_pp_src == "none"` → `unavailable`; empty-but-successful →
`observed_zero`), copied onto `LayerScores` after Pass A, and surfaced in
`criteria.dataStatus`, `dataQuality[].dataStatus`, and sparse-competition
next-validation actions.

## Candidate selection (`scoring.select_candidates`, `grid.py`)

1. **Exclusion mask** (`scoring.exclusion_mask` + all spatial masks in
   `jobs.py`) removes ineligible cells (water, land-cover, named/coord
   exclusions, corridors, buildability, metro buffers).
2. **Sort** eligible cells by Pass-A composite descending.
3. **Separation:** greedily accept cells, skipping any within
   `minCandidateSeparationHexRings` (default 2) H3 rings of an already-chosen
   candidate (`hex_distance_rings`) — kills near-duplicate neighbours.
4. **Top-K** for refinement = `min(execution.refineTopK=12, settings.refine_top_k)`;
   final `output.topN` (default 3) after Pass-B re-rank.
5. **Screening vs refined:** every candidate carries `screeningScore` (Pass-A,
   matches map colours) and `mcda_score` (Pass-B refined, the ranking basis);
   `rankingBasis` says which. The chosen cells' own map colour is overwritten
   with their refined score and flagged `refinedCandidate`.
6. **Naming / centroid:** winners are reverse-geocoded
   (`study_area.reverse_geocode_name`); colliding names get a compass
   qualifier (`results.disambiguate_names`). The lat/lng is the **H3 cell
   centroid** — a representative point of an investigation zone, never an exact
   site (enforced in wording across map/cards/PDF).

## Numeric contract (`engine/contracts.py`)

Every value entering scoring is coerced to a finite float by explicit policy
(`to_finite_float`): None/NaN/±inf → default + warning; single-item list →
unwrapped; multi-item list/dict/str → default + warning. `normalize_0_1`
never raises and always returns a finite `[0,1]` float (with the optional
`curve="target_band"`). This exists because a raw provider list once flowed
into an int aggregation and crashed a live job — **the new portal must keep an
equivalent contract** so provider shape drift degrades instead of crashing.
