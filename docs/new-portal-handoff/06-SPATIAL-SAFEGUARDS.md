# 06 — Spatial Safeguards

These are the deterministic guards that make the screening trustworthy. Each is
classified **MVP essential** / **later** / **do not port** with strict YAGNI.
The MVP-essential set is small and is the real reason the current portal's
results are defensible.

Format: safeguard — problem prevented — when it runs — data source — failure
behaviour — confidence effect — modules — **classification**.

## Land / water masks

**Baseline unbuildable-land mask (always-on)** — cells centred on
water/wetland/forest/military/airfield/bare-rock get recommended — runs every
analysis, one bounded Overpass fetch — Overpass area geometry — degrades to
"mask skipped, confidence reduced" on timeout — lowers confidence when skipped
— `jobs.py` baseline block + `buildability.centroid_in_polygon_mask` —
**MVP essential.** (Physical unbuildability is prompt-independent; a lake-dotted
area was scoring cells in lakes before v1.7.2.)

**Water mask (centroid + area-overlap)** — a candidate in the middle of a
river/lake — after grid build when water geometry present — Overpass
`natural=water`/`waterway=riverbank`/`river` (relation-aware multipolygons) —
skipped if geometry unavailable (withhold for waterfront briefs) — reduces
confidence for waterfront — `engine/water.py` (`water_mask`,
`water_overlap_mask` >30%) — **MVP essential.**

**Relation-aware water geometry** — big rivers mapped as OSM relations, not
single ways, being missed — during water fetch — Overpass `out geom` + relation
members — same as water mask — — `data_osm.fetch_area_geometries` +
`water.py` — **MVP essential** (part of the water mask being correct).

## Context-gated land checks

**Railway / ghat / heritage / open-space (maidan) masks** — building on rail
land, ghats, protected/sacred land, or open grounds — only for
commercial/waterfront briefs, planner-gated — Overpass tag sets + named-feature
regex — degrades to empty mask + note under a stage budget — reduces confidence
when degraded — `buildability.py` + `jobs.py` 4e stage + `planner_lite` gates —
**later** (valuable, but a stage-budget-managed nicety; MVP can ship with the
baseline mask only).

**Road-frontage / commercial-viability proxy** — a "commercial" zone with no
road frontage — planner-gated for frontage-sensitive briefs — Overpass road
lines — "unchecked" label when skipped — — `buildability.commercial_viability`
— **later.**

## Corridor / boundary gates

**Waterfront corridor (riverfront band)** — riverside brief recommending inland
cells — when `waterfront.isWaterfront` — river line or water-polygon boundary
fallback — withhold (never keep-all) if no geometry — reduces/ withholds —
`corridors.distance_to_lines_m` + `jobs.py` 4c + `constraint_policy` — **later**
(needed for riverside prompts; not day-one MVP unless waterfront is a launch
use-case).

**Bridge / landmark corridor bounds ("strictly between X and Y")** — zones
outside the stated segment — corridor include-mode with `maxDistanceM` — OSM
line geometry — gate not enforced (all kept) + honest note if no geometry — —
same corridor machinery — **later.**

## Exclusion gates

**Named-area exclusions ("exclude my Worli branch")** — recommending the user's
existing sites — when `namedExclusions` present — geocode + haversine buffer —
disclosed NOT-enforced if un-geocodable — — `jobs.py` named-exclusion block +
`deterministic_planner.parse_named_exclusions` — **MVP essential** (cheap, high
product value, no provider risk beyond geocode).

**Coordinate exclusions ("within 3 km of lat/long")** — same, by exact coords —
when coord entries present — **no geocoding** (verbatim coords) — always
enforceable — — `parse_coordinate_exclusions` + `jobs.py` — **MVP essential.**

**Metro exclusions ("outside 1 km of any metro")** — buffering non-metro
stations — when a metro exclusion is detected — verified static station lists
(`metro.py`) with OSM fallback — unenforced → treated as failed spatial
constraint — reduces confidence — `metro.py` + `jobs.py` — **later** (static
data maintenance; MVP can treat as a generic OSM exclusion).

## Route gates

**Route constraints (drive/walk time, railway crossing)** — a "10-min drive"
gate passing without route evidence — planner-gated when route constraints
exist — ORS Directions / Google Routes — **unavailable ≠ pass**: unevaluable
required routes exclude the candidate — reduces confidence/withholds —
`routing.py`, `route_policy.py`, `jobs.py` 6b — **later** (needed for
dark-kitchen-style prompts; not day-one unless that's a launch use-case).
The **invariant** it encodes ("a route requirement cannot pass without route
evidence") is **MVP essential** even if the ORS integration itself is later.

**Traffic-aware routing + free-flow fallback label** — a free-flow "10-min
drive" overstating reach in congested metros — Pass-B for `trafficAware` drive
layers — Google Routes typical traffic — free-flow proxy kept **with honest
label** — — `traffic.py`, `results._catchment_label` — **later** (the honesty
label is a keeper idea even if traffic realism is deferred).

## Stale-context guards

**Stale-corridor / waterfront false-positive prevention** — an LLM
hallucinating riverside context; a water corridor carried from a prior turn —
during chat turn — deterministic `detect_waterfront` regex on the raw prompt —
overrides LLM flag / strips carried corridor — — `llm.py` waterfront + corridor
guards — **MVP essential** (any LLM-led portal will hallucinate context;
deterministic override is the cheap fix).

**Stale-context reset on new brief** — a new city inheriting old
exclusions/weights/study area — chat turn — `NEW_ANALYSIS_RE` + business-type
staleness check — strips carried spatial/strategy keys — — `llm.py` — **MVP
essential.**

**User-adjusted weight / grid preservation** — archetype defaults wiping a
customer's slider choice across turns — deterministic override — spec flags
`weightsAdjustedByUser` / `gridResolutionAdjustedByUser` — preserves user
choice — — `deterministic_planner.preserve_user_weights` /
`preserve_user_grid_resolution` — **MVP essential** as a *pattern* (a
re-planning turn must not clobber explicit user edits).

## Result-integrity guards

**Required-data withholding** — ranking on a required factor with no data —
after Pass A — data-sufficiency check — every candidate excluded, status
`insufficient` — — `scoring.required_missing_layers` + `jobs.py` gate — **MVP
essential.**

**Centroid-vs-exact-site wording** — implying an H3 centroid is a real property
— result construction + all render surfaces — — — "Investigation-zone centroid
(approximate)" everywhere — `MapView`, `ResultsDrawer`, PDF, `results.py`
`siteClaimLevel` — **MVP essential** (it is the product's honesty spine, and
it is free).

**Three-state result contract (success / no_viable_site / failed)** — a raw
exception becoming the user-facing result — job runner — structured payloads —
— — `jobs._failed_result`, `_run_in_thread` — **MVP essential.**

## Summary classification

- **MVP essential:** baseline land-cover mask, water mask (+ relation-aware
  geometry), named + coordinate exclusions, stale-context guards (waterfront /
  corridor / new-brief), user-edit preservation pattern, required-data
  withholding, centroid wording, three-state result contract, and the
  *invariant* that a route/constraint cannot pass without evidence.
- **Later:** context-gated land checks (railway/ghat/heritage/frontage),
  waterfront/bridge corridors, metro exclusions, ORS route gates, traffic-aware
  routing (keep the free-flow honesty label idea).
- **Do not port:** custom-layer sandbox execution (security surface, unused),
  GCS snapshot restore (disabled), the deterministic archetype override itself
  (that's the whole point of the rewrite).
