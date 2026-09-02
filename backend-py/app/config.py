"""Server configuration — all secrets come from env / .env, never from code.

v1.1.0: added configurable model routing + cost-mode tiers.
v1.1.1: refreshed model defaults to the cost-aware gpt-5.4 family.
v1.1.2: water tag helper import fix.
v1.2.0: deterministic planning mode — canonical archetype schemas, spec fingerprinting.
v1.3.0: evidence trail & reproducible site-selection reports.
v1.4.1-1.4.7: execution-flow reliability, provider degradation, results-crash
  safety, numeric scoring contract (contracts.py), three-state result payload
  (success/no_viable_site/failed) — shipped across several commits without an
  APP_VERSION bump; folded into this bump.
v1.4.8: typed Google provider layer (Places API New, Places Aggregate,
  Routes, Place Details) with legacy Places / OSM / ORS retained as fallback.
v1.4.9: PlannerLite — a minimal per-prompt relevance gate (engine/planner_lite.py)
  that skips irrelevant water/buildability/routing/Places-refinement stages
  instead of running the same generic checklist for every prompt. Adds
  analysisCompleteness to the result payload and a plannerPreview on the spec
  card. No new providers, no engine rewrite — a YAGNI resource-optimization
  release on top of the v1.4.8 provider layer.
v1.5.0: Analysis Intelligence Lite — deterministic prompt/spec classification
  (businessArchetype/locationIntent/riskTriggers/analysisMode), scenario
  ranking stability over the final shortlist, granular dataSufficiencyV2,
  and the honest investigation-zone label taxonomy — all surfaced in the UI.
  Zero new provider calls; purely local derivations over existing run state.
v1.5.1: Hard Constraint Verification Visibility — one structured
  hardConstraintVerification payload object (per-requested-constraint status:
  verified / proxy_verified / not_verifiable / requested_not_enforced /
  failed / not_required) + per-candidate hardConstraintWarnings, surfaced in
  the ResultsDrawer. Pure mapping of existing run state; shipped without an
  APP_VERSION bump — folded into this bump.
v1.5.2: Reliability & Consistency — (1) buildability stage budget + bounded
  concurrent Overpass fetches (fixes the live 240s job timeouts); (2)
  deterministic PlannerLite water relevance (an LLM-attached water exclusion
  can no longer flip the stage plan for the identical prompt); (3)
  small-format grocery archetype correction (neighbourhood retail, not
  hypermarket); (4) block-granularity res-10 grid rule from the user's own
  words; (5) deterministic templated objective (identical prompt →
  byte-identical objective) with waterfront detection reading the raw prompt;
  (6) screening-vs-refined score transparency (screeningScore/rankingBasis on
  every candidate + a map→refined chip in the UI).
v1.6.0: Factor Weight Sliders (Phase 2) — the plan-card and results-drawer
  weight sliders are now fully wired end to end. Adjusting a weight on the
  plan card before running is flagged (weightsAdjustedByUser) and PRESERVED
  by the deterministic planner across chat turns instead of being silently
  reset to archetype defaults (a real bug: typing "run" after adjusting used
  to wipe the adjustment). Post-run sliders in the ResultsDrawer re-rank
  candidates AND recolor the hex-grid map instantly, client-side — no re-run,
  no provider calls. Every analysis records a weightAudit (default vs.
  executed weights, adjusted-by-user flag) so an adjusted ranking is never
  presented as the untouched default methodology. Also fixes a pre-existing
  frontend scoring bug: a factor with no data was counted as a fabricated
  zero in the weighted mean instead of being excluded from it.
v1.6.1: Confidence, Report, Quotas, Security (Phase 3) — (1) unifiedConfidence:
  ONE headline confidence verdict (conservative min of dataSufficiencyV2 and
  the reliability critic, with the disagreement explained), replacing three
  independently-visible signals that could disagree without explanation; (2)
  the PDF report gains an Overall Confidence section and a Factor Weight Audit
  table (default vs. applied weights, headed "ADJUSTED BY USER" when the
  customer moved a slider); (3) payment-grade per-customer quotas — admin-
  granted users/{uid}.maxPrompts (Firestore rules: admin-grant-only, enforced
  atomically in a backend transaction, never client-writable), replacing the
  single hardcoded 10-prompt cap; (4) server-side identity + quota enforcement
  (app/auth_quota.py) on /api/v2/chat and /api/v2/analyses via Firebase ID
  tokens — OFF by default (STRATAGEO_REQUIRE_USER_AUTH=false) for rollout
  safety, fail-closed when turned on; (5) a per-user chat-turn rate limit
  (60/hour default) closing an unmetered-LLM-spend gap. See
  docs/PHASE3-SECURITY-REVIEW.md for the full review; flipping
  STRATAGEO_REQUIRE_USER_AUTH to true is a deliberate go-live action, not
  bundled with this deploy.
v1.6.2: Smart water/buildability relevance — fixes a live-observed failure
  ("high-end gym in Mumbai" put a candidate on the coastline/dockyard edge and
  another near Port Trust/CSMT railway land). Two gaps, both closed: (1) the
  PlannerLite relevance gate's buildability check used a narrower,
  independently-drifting regex than the one jobs.py._buildability_flags()
  actually applies — the two are now the SAME function, so a commercial
  brief ("gym", "cafe", "supermarket", etc.) can never again have its
  no-build-land protection silently zeroed by the gate; (2) water relevance
  was pure prompt-text matching with zero geography awareness — a resolved
  coastal/port metro (Mumbai, Chennai, Kolkata, Kochi, …) now triggers the
  water mask even with no water wording in the prompt at all. Both fixes mean
  water AND buildability now fire TOGETHER far more often (every coastal-
  metro commercial brief, not a rare combination) — so this release also
  launches the water-body fetch and the buildability fetch group
  CONCURRENTLY instead of sequentially (they were previously two separate
  blocking awaits, worst case ~135s combined; now launched together as
  asyncio tasks, worst case bounded to max(water, buildability) ~90s),
  closing the actual timeout risk broader triggering would otherwise have
  introduced. Pinned by a real-wall-clock regression test, not just a
  mask-correctness check.
v1.6.3: H3 grid-level choice — the default analysis grid coarsens from
  resolution 9 (~0.10 km² hexes) to resolution 8 (~0.74 km² hexes), and the
  plan card now lets the customer choose between level 7 (~5.2 km²,
  district-scale, fastest) and level 8 (~0.74 km², neighbourhood-scale,
  default) before running. The choice is flagged
  (gridResolutionAdjustedByUser) and PRESERVED across chat turns by the
  deterministic planner (mirroring the Phase-2 weight sliders), and an
  explicit UI choice wins over the prompt-wording res-10 block-granularity
  override. polyfill() auto-degrade and the 7–10 spec clamp are unchanged.
v1.6.4: Map coherence & coordinate fidelity — three live-reported issues.
  (1) A chosen candidate's map cell is now recoloured with its FINAL
  (Pass-B refined) score and flagged refinedCandidate, so a pick's colour
  always matches the number on its card; all other cells keep the Pass-A
  screening surface (the only basis on which every cell is comparable).
  (2) When the recommendation is withheld (unreliable analyst review / no
  viable land), the frontend hex surface renders neutral grey with
  context-only tooltips instead of confident green/red gradation.
  (3) Coordinate fidelity: "Name[lat, lng]" place strings are parsed
  deterministically from the user's raw prompt (deterministic_planner) and
  read verbatim by resolve_study_area — never sent to a text geocoder
  (observed live: geocoder fell back to a country-level "India" match and
  the analysis ran near the centroid of India). Country/state-level geocode
  matches are now rejected outright for every brief. Bonus: a candidate
  shortfall (< topN survivors) is now explained in the result notes.
v1.6.7 (cumulative, includes v1.6.5/v1.6.6): Report map & weight-responsive
  grid ranks. v1.6.5 — refined scores are RELATIVE to the shortlist and now
  say so: each refined criterion carries a comparative block (n/min/max/
  position, basis relative-to-shortlist) so "0.0 with 934 features observed"
  reads as "lowest among candidates", not "terrible"; spread-aware refit in
  scoring.py stops near-identical refined values stretching to 0..10;
  evidence badges report the ACTUAL data source with a separate
  lowConfidenceProxy flag instead of an opaque "ai-generated" overwrite.
  v1.6.6 — the candidate-shortfall note names the actual responsible filter
  (e.g. the required travel-time route check, with the failed count).
  v1.6.7 (frontend) — the PDF report embeds a self-rendered analytical map
  figure (H3 surface, AOI boundary, ranked pins, legend, scale bar; grey
  when the recommendation is withheld; custom weights disclosed in the
  caption) plus per-zone "Open in Google Maps" links; every eligible grid
  cell is ranked (hover: "rank 17 of 214"), ranks recompute live under the
  weight sliders, and moving weights re-SELECTS a screening-basis top-X from
  the whole grid (dashed amber pins + list), explicitly labeled unverified
  with a bold routing caveat when a travel-time constraint exists.
v1.6.8: Pune-run fixes + professional report. Backend (boss patch): (1) a
  single NAMED place study area now uses the geocoder's full mapped extent
  (sanity window 1.5-60 km diagonal) instead of a 2 km point buffer —
  "Pune" previously analyzed a 17-hex dot around its centroid; (2) explicit
  "radius of 1.5 km" / "800 m catchment" prompt phrasing deterministically
  overrides euclidean catchments (clamped 200 m – 5 km), disclosed in notes;
  route constraints correctly excluded; (3) Places API (New) 400s fixed:
  legacy meta-types (point_of_interest, establishment, …) are stripped from
  includedTypes, an empty type list never sends the doomed request
  (degraded: no_valid_new_api_types_for_layer), and any future 4xx carries
  Google's actual error message in the note; (4) a single shortlisted
  candidate is scored on the study-area screening basis instead of a
  self-comparison that flagged every factor "did not vary"; (5) top-3
  default disclosed in notes when the prompt names no count; (6) drawer
  progressive disclosure (notes collapse to 3, constraint detail expands
  only when something needs attention). Frontend (report overhaul): the PDF
  map figure now draws real Carto basemap tiles (same CORS-enabled source
  as the on-screen map, attributed; clean tile-less fallback), Web Mercator
  projection, north arrow, in-frame scale bar, neatline, labeled legend;
  all report text is Latin-1 sanitized (fixes the garbled evidence
  appendix); key analysis notes appear on page 1; empty/placeholder
  sections are omitted ("Planning mode: not set", empty GIS assessment);
  the stale "GPT-4o-mini" methodology text replaced with an accurate v2
  engine description; internal enum values humanized.
v1.7.0: Scoring Standard v1 (boss patch). The per-factor normalization
  default changes from linear "percentile" to "log_percentile" — values are
  log1p-transformed, then percentile-stretched (p5–p95). Every factor in the
  product is a POI count and urban counts are heavy-tailed (roughly
  log-normal): under linear scaling one CBD mega-cell forced cells with 20
  vs 110 co-tenants into nearly the same score; log scaling is the standard,
  defensible treatment for count data and spreads the mid-range where siting
  decisions actually live. Ranking order is always preserved (tested); only
  exaggeration is removed, so the earlier "0.0 next to 934 observed"
  complaint is now structurally impossible. Recorded in-code and test-locked
  as Scoring Standard v1 — a deliberate PRE-LAUNCH decision (no customer
  scores existed to preserve) that must become a versioned, disclosed event
  if ever changed once customers hold reports. Linear "percentile" and
  "minmax" remain available per-layer for future non-count metrics. The
  methodology disclosure (report + panel) reads the method automatically, so
  it now states log-space normalization without any hardcoded text.
v1.7.1 (reverted, then reinstated by v1.7.2): Stress-test battery — drive
  catchments traffic-aware by default (+ free-flow honesty label),
  prompt-stated factor weights, named-place exclusions of existing sites,
  rent/floor-area feasibility note. Shipped as 1.7.1, reverted per an
  operator request (the Bengaluru run looked broken), then reinstated as
  part of the cumulative v1.7.2 patch below, which also fixes what that run
  exposed. Tag `v1.7.1` preserves the original release commit.
v1.7.2: Bengaluru supermarket run fixes (boss patch, supersedes v1.7.1).
  (1) Custom MCDA weights now parse even in bare "Name (0.5)" form — but
  ONLY when the prompt explicitly frames them as weights/MCDA AND the
  numbers roughly sum to 1 (a stray "(2024)" or "(3 km)" never matches);
  factor names are matched to scoreable factors by word-stem overlap plus a
  small domain synonym bridge ("Competitor"↔"competition", "Affluence"→
  co-tenancy), and a criterion with no scoreable factor (e.g. Parking) is
  disclosed in promptWeightUnmatched, never silently eaten. (2) Coordinate-
  anchored exclusion: "exclude within 3 km of lat: 12.9067, long: 77.5818"
  is parsed deterministically to an exact coordinate + buffer (never
  geocoded, never modeled by the LLM) and fenced off from the search-radius
  override so the exclusion radius can't be misread as a catchment. (3)
  Corridor contamination guard: a water-tagged corridor carried over from a
  previous riverside turn is stripped whenever the deterministic detector
  finds no water signal in the current prompt (a landlocked South Bengaluru
  supermarket was executing a "strict riverfront corridor" and returning
  no_viable_site with riverfront relaxation advice); the zero-viable message
  is now truthful for every brief, riverfront wording only for genuine
  waterfront briefs. (4) Always-on baseline unbuildable-land mask: one
  bounded Overpass fetch masks cells centred on water, wetland/mangrove,
  forest/wood, military land, airfields and bare rock/scree for EVERY run
  (physical unbuildability doesn't depend on prompt wording — lake-dotted
  areas were scoring cells sitting in lakes); degrades gracefully with a
  disclosed confidence reduction if the provider times out. Heavier
  context-dependent checks (railway, ghats, heritage, road frontage) remain
  planner-gated. Roads/slope stated openly as parcel-level/DEM questions
  outside screening resolution.
v1.8.0: Screening & Investigation-Zone Product Contract (vNext). The result
  payload gains the customer-facing screening vocabulary as a pure PROJECTION
  of the existing honesty gates (nothing can be upgraded by it):
  (1) screeningVerdict per zone — Priority / Promising / Conditional /
  Low priority / Withheld, mapped from investigationLabel with rank
  awareness; claimLevel per run (investigation_zone / uploaded_candidate).
  (2) nextValidation per zone — concrete next-stage validation actions
  generated from the ACTUAL unmet or screening-stage requirements of the run
  (unsupported constraints, unverified route checks, sparse competition
  coverage, degraded land checks), never generic boilerplate
  (engine/screening_contract.py). (3) Target-band competition curve —
  Layer.scoringCurve="target_band" scores an inverted-U (peak at 0.35 of the
  observed range) so "less competition but not zero" briefs stop treating
  zero observed competitors as ideal; applied deterministically when the
  prompt says so (detect_competition_band), disclosed in the factor
  justification and the explanation-pass prompt. (4) Observed absence is not
  missing data — LayerScores.data_status distinguishes observed_zero (query
  succeeded, zero features: a real, disclosable observation) from
  unavailable (provider failed: unknown, not absent); surfaced per factor in
  criteria dataStatus/evidenceBasis and dataQuality. (5) Spatial-scale
  classification (site_or_block / micro_market / locality / city /
  metro_region / corridor) in analysisIntelligence.spatialScale, with a
  frontend methodology-comparison block for micro↔macro follow-ups (criteria
  retained / added / removed, scale + catchment changes). (6) Follow-up
  hardening — deterministic MODIFY_SIGNAL (recalculate / reweight / reverse /
  exclude / expand / compare …) keeps imperative refinements at the framework
  stage with the spec carried forward; an explicit "start a new analysis"
  strips carried spatial/strategy context (corridors, exclusions, adjusted
  weights, route gates, study area) while keeping the business type. (7)
  Reweight verification (§8.2 Option A) — client-reweighted shortlists stay
  clearly provisional with rank deltas vs the verified original (newly
  promoted zones marked NEW — UNVERIFIED, inheriting no evidence), plus a
  "Verify adjusted shortlist" action that re-runs the analysis with the
  user's weights baked in (audited via weightsAdjustedByUser). (8) Results
  presentation — executive header (screened cells, top zone + verdict,
  confidence, critical next check), zone cards lead with evidence-backed
  reasons / key risk / next validation, zone-centroid wording on map and
  cards, PDF gains the verdict strip, constraint-status table, per-zone
  next-validation and a professional detailed-validation CTA; the results
  drawer gains the same CTA with a copyable, prompt-free summary.
v1.8.1: Hotfix (live JP Nagar 2nd Phase grocery run). (1) Study-area
  minimum-extent floor — the type="places" path already enforced a 2 km
  minimum buffer, but type="point_radius" and type="bbox" used the LLM's
  value VERBATIM with no floor. A "specific intersections or blocks" brief
  makes the model pick a tiny study area; the deterministic planner then
  bumps the grid to res 10, polyfill collapsed to ~1 hex, a single mask
  removed it, and the run reported a FALSE "no viable site". All three
  study-area types now floor to MIN_STUDY_AREA_RADIUS_M (1.5 km) with a
  disclosed note (engine/study_area.py). (2) Frontend: the "Try widening
  riverfront corridor to 500 m" button was gated only on
  `(waterfront?.corridorWidthM ?? 0) < 500` — which is 0 < 500 = true when
  waterfront is null — so it rendered on landlocked withheld results; now
  gated on `waterfront.isWaterfront`. (3) "1 grid cells" pluralization.
v1.9.0: Frictionless & Simple (live new-user feedback: too many steps to run,
  cluttered results, unclear "no reliable recommendation"). Reliability:
  (1) Route-gate pre-mask — a required proximity route constraint now
  restricts WHERE candidates are selected from (generous straight-line
  envelope of the geocoded target, limit x 1.35; exact ORS/Routes check
  still verifies per candidate). Previously screening picked the best
  composite cells anywhere in the study area and the gate then excluded
  them all (observed live: Ruby Crossing QSR — best cell 2,030 m away vs
  an 800 m limit -> false "No reliable recommendation"). (2) Anchor
  double-encoding guard — an exclusion that targets the same anchor as a
  required proximity constraint is contradictory (unsatisfiable together)
  and is dropped with a disclosed note. (3) plainReason — every withheld
  ranking now carries ONE computed plain-English sentence (route near-miss
  numbers, missing required inputs, or emptied grid) plus actionable
  suggestions for the route-failure case. Friction: the frontend Run button
  now appears as soon as a VALID spec exists (no more typing "run analysis"
  to reveal it), and the chat prompt goes straight to a compact framework
  when the first message names a business + location (scenarios/validation
  live on the plan card only; replies capped ~18 lines; ends "press ▶ Start
  analysis", never "type run"). Simplicity: the results drawer is
  simple-first — verdict, plain-English reason, what-to-try-next and zones
  stay visible; ALL diagnostic panels (data-sufficiency grid, constraint
  verification, degraded checks, repair warnings, scope, analyst review,
  full confidence rationale) collapse behind one "Technical diagnostics"
  expander with a notice count; internal enum tokens humanized.
v1.10.0: Sensible Output (live Sector V supermarket run: 6 grid cells, 2
  eligible, top-3 requested but 1 zone returned, and "0.0/10 despite 439
  observed" score artifacts from a 6-value percentile stretch).
  (1) Adaptive grid resolution — polyfill(min_cells=40, settable via
  MIN_GRID_CELLS) refines the H3 level upward (to at most 10) when a small
  locality yields a grid too small to rank, with a disclosed note; the
  existing max_hexes degrade loop is untouched and the two cannot conflict.
  (2) Adaptive candidate separation — the near-duplicate ring rule scales
  DOWN on small eligible grids (<15 cells → 0 rings, <60 → ≤1) so a compact
  study area can still return the requested top-N distinct zones; never
  scaled up, always disclosed. (3) Explanation-pass style discipline — the
  summary is 2-3 short plain-language sentences naming the top driver and at
  most one caution; no per-factor score dumps, no meta-commentary about
  scoring mechanics. Also fixes the explanation pass silently 400-ing
  (results.py passed the raw legacy explain_model alias, default "" — now
  effective_report_model; shipped mid-v1.9.0 as engine-00073). (4) Natural
  chat tone — plan replies open like a colleague ("Got it — …"), no
  Objective/Constraints/Feasibility section headers (constraints table only
  for 3+ explicit constraints), ~12-line budget plus the factor table.
  (5) The analyst-narrative paragraph in the results drawer is opt-in behind
  a "📝 Analyst narrative" expander — the executive header already tells the
  at-a-glance story.
v1.11.0: Exclusion Integrity (live failure: "exclude my existing areas in
  Colaba and Worli" was acknowledged in chat as a hard no-go, then Colaba was
  returned as a ranked candidate zone). Two stacked defects, both fixed:
  (1) SCHEMA DRIFT — deterministic_planner wrote spec["namedExclusions"] (and
  competitionCurve, promptWeightUnmatched), but SpecV2 never declared these
  fields. Pydantic v2 defaults to extra='ignore', so validation silently
  dropped them; the jobs.py mask loop is guarded by
  getattr(spec, "namedExclusions", None), which therefore always saw None —
  the exclusion was never applied AND the "could not be enforced" disclosure
  never fired, so the failure was invisible. This had been dead code since
  v1.7.1/v1.7.2 (named + coordinate exclusions, competition target-band flag,
  prompt-weight-unmatched notice all affected). All three fields are now
  declared on SpecV2; a new schema-drift test fails the build if the planner
  ever again writes an undeclared spec key. (2) WRONG SHAPE — even once
  applied, the mask was a fixed circular buffer on the geocoded centroid; a
  neighbourhood like Colaba is a ~3 km peninsula, so a 1.5 km circle left its
  northern half selectable. Exclusions now use geocode_with_bbox()'s real
  extent (union of bbox-membership and the buffer, so the buffer is always a
  floor), with a 12 km coarse-match cap so a city-level geocode can't wipe the
  study area. Enforcement is now a first-class payload field
  (exclusionsApplied / exclusionsUnenforced), not a buried diagnostics note.
v1.11.2: Plain Language (live feedback: "can we make the chatting more organic
  and start analysis more subtle, also still a lot of info which I really have
  to read to understand what's going on in the sidebar").
  (1) Chat tone — the framework reply is now prose plus a few plain bullets
  instead of a Constraint table + a 6-column Factor table. The chat no longer
  duplicates what the plan card already renders (weights, directions,
  confidence, scenarios all live in the spec block); it says in real-world
  words what will be weighed most and what can't be verified from map data.
  No section headers, no tables unless the user explicitly asks for weights or
  methodology, ~10-line budget, and a varied natural closing line that never
  names or draws the Start button.
  (2) Start-analysis affordance — label "▶ Start analysis" → "Run analysis",
  restyled from a full-width solid-blue slab to a quiet right-aligned outline
  button. Same single click, same always-visible placement; it just no longer
  reads as the loudest element on screen.
  (3) Sidebar scannability — the executive header leads with the zone name and
  score, and the top drivers render as labelled bars (topFactorSignals) rather
  than a prose run-on ("Strong road / transit accessibility (9.8/10) · Strong
  demand density proxy (6.1/10) · …"). Per-zone cards use the same bars. The
  screening-claim caveat, previously stated three times (verdict banner, exec
  header footer, disclaimer box), is now stated once above the zone list; the
  verdict banner is a compact chip. Pure presentation — no scoring, ranking or
  claim-level semantics changed.
v1.11.3: Coastline & Quiet Detail (live run: a South Mumbai gym analysis put
  candidate zones in the Arabian Sea off Malabar Point).
  (1) OPEN-SEA MASK — the water mask fetched natural=water / waterway=*, which
  covers rivers, lakes, docks and ponds because those are mapped as AREAS. The
  ocean is NOT a polygon in OpenStreetMap: it is defined implicitly by
  natural=coastline ways, so a coastal city fetched zero geometry for the sea
  and every offshore hex survived the mask. Adding the tag alone would not have
  helped — a coastline is an OPEN line that never polygonizes into a ring.
  water.build_sea_polygons() now cuts the study bbox with the merged coastline
  and labels each resulting face using OSM's convention that LAND lies on the
  LEFT of a coastline way and SEA on its RIGHT (verified by a test that
  reverses the way direction and asserts the sea side flips).
  sea_overlap_mask() then applies the same >30% area threshold used for inland
  water, so genuine waterfront cells that are mostly land are kept and only
  offshore cells are removed. Fail-safe throughout: no coastline, a coastline
  that does not divide the area, a degenerate bbox, or an undecidable face vote
  all mask NOTHING — wrongly masking land would delete valid candidates, which
  is worse than missing some sea. Reported as maskStats["seaOverlapRemoved"].
  (2) QUIET DETAIL — per the same feedback ("keep the confidence why and all
  the technical explanation in collapsed tabs below"), the standalone
  confidence banner is gone on normal results (the executive header subline
  already states the level; the merge rationale stays in Technical
  diagnostics) and is retained only when the ranking is withheld, where the
  header does not render. Per-zone cards no longer stack confidence label,
  ranking stability, score band, screening→refined delta and the R/V/C pills
  in the score column; all five moved into that card's expander under "Score
  details", relabelled in words ("Rank vs peers", "Absolute viability", "Data
  confidence") instead of "R:10.0 V:7.4 C:8.1". Nothing removed, one click away.
v1.12.3: Unrequested Exclusions & the Stranded Grid (live run: "Find 3 best
  locations for a premium cafe in Indiranagar, Bengaluru" returned NO
  recommendation at all, and no hex surface was drawn).
  (1) PROMPT LEAKAGE — the result was withheld because of a "Metro exclusion:
  strictly outside 1km of any metro station" that the brief never mentioned.
  That exact string was the illustrative example in rule P7d of
  services/prompts.py; the planner copied the illustration into a real
  exclusions[] entry. The spec then contradicted itself — a 25%-weighted
  "Transit / metro access" factor rewarded the very thing the exclusion banned
  — and because an unresolvable hard exclusion withholds the ENTIRE ranking,
  one fabricated gate destroyed an answerable analysis. P7d now teaches with
  <feature>/<distance> placeholders and states outright that an exclusion the
  user did not ask for must never be emitted.
  (2) ONE-WAY TRACEABILITY — intent_parser.validate_hard_constraints_in_spec()
  only ever checked that every constraint the USER stated has a gate. Nothing
  checked the inverse, so an invented gate passed unguarded.
  jobs.drop_unrequested_exclusions() closes that direction, deliberately
  conservative: it drops an exclusion only when the user's own words contain no
  avoidance phrasing at all AND none of the exclusion's signal words appear in
  the prompt. Every drop is disclosed in notes, never silent.
  (3) STRANDED GRID — v1.12.2 stopped DROPPING GeoJSON writes that arrived
  while the Mapbox style was mid-settle and buffered them instead, but drained
  the buffer only from the load / style.load handlers. Those fire once at
  startup and never again unless the basemap is swapped, so a hexGrid arriving
  during the post-analysis camera move was buffered and then stranded forever
  — measured live at 53 features buffered against 0 in the sg-hex source.
  Writes now arm their own map.once("idle") retry instead of trusting an event
  that may already be in the past.
v1.12.4: Buildability Relevance (live: every Indiranagar run reported "Provider
  degraded — no-build mask check(s) were skipped: ghat, protected_area",
  capping confidence on an otherwise clean analysis).
  Measured against Overpass for that bbox with the real fetch code: ghat 41.7s
  -> 1 feature ("Dhobi Ghat", a laundry); maidan 68.4s -> 0 features;
  protected_area 33.0s -> 460 features; railway_area 28.6s -> 20. The two name
  scans monopolised both concurrency slots and exhausted the 90s stage budget,
  starving the one check that mattered — and because a timed-out fetch caches
  nothing, the same area degraded on every subsequent run forever.
  (1) The ghat mask is gated on WATER relevance instead of "is commercial": a
  ghat cannot exist without a river, lake or sea. (2) The "...Maidan" name scan
  becomes a FALLBACK, running only where the tag-based open-space fetch came
  back thin (<=10 features) — it exists for poorly-mapped areas, and Bengaluru
  returned 460 polygons. (3) An Overpass endpoint that fails is de-prioritised
  for a 5-minute cooldown instead of being re-tried on every call: both
  non-canonical mirrors were failing, so each fetch paid two doomed attempts
  plus sleep(0.5) before reaching the working endpoint. Also widens _WATER_RE's
  `beach` term to its -side/-front/plural variants, a gap the new tests exposed
  — every other water term already had them, so "beachside" read as landlocked
  and gated the water mask itself (the v1.11.3 failure class).
"""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# ── Version metadata (single source of truth) ─────────────────────────────────
APP_VERSION     = "1.12.4"
API_VERSION     = "v2"
ENGINE_VERSION  = "stratageo-engine-00078"
# SPEC_VERSION / EVIDENCE_VERSION_PUBLIC are NOT bumped for v1.5.1/v1.5.2/
# v1.6.0/v1.6.1/v1.6.2/v1.6.3 — the SpecV2 wire schema and the EvidenceTrail
# schema are structurally unchanged; hardConstraintVerification /
# screeningScore / rankingBasis / canonicalWeights / weightsAdjustedByUser /
# unifiedConfidence / gridResolutionAdjustedByUser are additive keys outside
# these versioned contracts. v1.8.0 likewise: Layer.scoringCurve defaults to
# "monotonic" (same precedent as Catchment.trafficAware in v1.7.1), and
# screeningVerdict / claimLevel / nextValidation / dataStatus / spatialScale
# are additive result-payload keys — older saved/shared payloads render
# unchanged (frontend normalizer treats them all as optional).
SPEC_VERSION    = "2.3"
EVIDENCE_VERSION_PUBLIC = "1.4.0"
RELEASE_NAME    = "Buildability spends its budget only on checks that can apply"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        # .env takes precedence over process env vars: a stale user-level
        # OPENAI_API_KEY on a dev machine must not shadow the project's .env.
        # In production (Cloud Run) no .env exists, so env vars apply as usual.
        return init_settings, dotenv_settings, env_settings, file_secret_settings

    # ── Secrets ───────────────────────────────────────────────────────────────
    openai_api_key: str = ""
    google_places_api_key: str = ""
    ors_api_key: str = ""
    app_shared_token: str = ""
    # v1.12.0 — Mapbox GL JS PUBLIC token, served to the browser at runtime by
    # /api/v2/map-config rather than baked into the frontend bundle at build
    # time. Keeping it out of the bundle means it never enters the repo or a
    # build artifact (GitHub push protection flagged the baked-in version), and
    # it can be rotated by updating this env var alone — no frontend rebuild.
    # It is still public by nature: any visitor can read it from the network
    # tab. Its real protection is the URL restriction on the Mapbox account.
    mapbox_token: str = ""

    # ── CORS / origin ─────────────────────────────────────────────────────────
    frontend_origins: str = "http://localhost:5173"

    # ── Model routing (v1.1.1 — cost-aware gpt-5.4 family) ───────────────────
    # Defaults use the cost-efficient gpt-5.4 family.
    # Override any model via STRATAGEO_* env vars.
    # NO Pro-tier model is ever a default here.
    #
    # low mode (default):
    #   chat/reasoning = gpt-5.4-mini  (cost-efficient conversational)
    #   report/fast    = gpt-5.4-nano  (cheapest, for summaries/templates)
    #   critic         = gpt-5.4       (better reasoning for quality review)
    #
    # balanced mode:
    #   report         = gpt-5.4-mini  (better summaries)
    #   critic         = gpt-5.4
    #
    # high mode (escalation must be explicitly enabled):
    #   chat/reasoning = gpt-5.4       (stronger reasoning for hard prompts)
    #   critic         = gpt-5.5       (best available critic; NOT Pro)
    stratageo_chat_model: str = "gpt-5.4-mini"  # conversational consultant turns
    stratageo_reasoning_model: str = "gpt-5.4-mini"  # spec building, hard constraint resolution
    stratageo_critic_model: str = "gpt-5.4"     # post-execution self-critique
    stratageo_report_model: str = "gpt-5.4-nano"  # per-candidate explanations + summary
    stratageo_fast_model: str = "gpt-5.4-nano"   # templates, concise descriptions

    # Optional escalation to stronger models for difficult prompts.
    # Disabled by default — enabling costs more money.
    # In high mode with escalation=true, gpt-5.5 may be used for critic only.
    stratageo_enable_model_escalation: bool = False
    # Model to use when escalation fires. Falls back to chat_model if empty.
    # Must never be a Pro model.
    stratageo_escalation_model: str = ""

    # Safe fallback models if configured models fail and fallback is enabled.
    # Fallback is DISABLED by default; only activate when operator has verified
    # the primary models are unavailable.
    stratageo_enable_model_fallback: bool = False
    stratageo_fallback_chat_model: str = "gpt-4o"
    stratageo_fallback_fast_model: str = "gpt-4o-mini"

    # Cost mode controls how many LLM calls the engine makes:
    #   low      — deterministic-first; one LLM call; template explanations; no critic (DEFAULT)
    #   balanced — one critic call; better executive summary
    #   high     — optional escalation; richer reports; critic always on
    # DEFAULT = low: this upgrade is cost-sensitive; operator must explicitly opt into balanced/high.
    stratageo_max_llm_cost_mode: Literal["low", "balanced", "high"] = "low"

    # Legacy aliases kept for backward compatibility with existing .env files
    # and Secret Manager entries.  New code should use stratageo_* names above.
    chat_model: str = ""      # if set, overrides stratageo_chat_model
    explain_model: str = ""   # if set, overrides stratageo_report_model
    critic_model: str = ""    # if set, overrides stratageo_critic_model

    # Critic on/off (legacy flag honoured for existing deployments)
    critic_enabled: bool = True

    # ── Safety / abuse guards ─────────────────────────────────────────────────
    sandbox_enabled: bool = False
    rate_limit_per_min: int = 20
    rate_limit_global_per_min: int = 200
    max_request_bytes: int = 256 * 1024
    max_messages: int = 60
    max_message_chars: int = 12_000

    # ── Engine tuning ─────────────────────────────────────────────────────────
    max_hexes: int = 8000
    # v1.10.0 — minimum grid size worth ranking. Below this, polyfill refines
    # the H3 level (up to 10) so a small locality still yields a comparable,
    # rankable surface instead of a handful of noise-normalized cells.
    min_grid_cells: int = 40
    refine_top_k: int = 12
    ors_batch_size: int = 5
    walk_speed_m_per_min: float = 80.0
    drive_speed_m_per_min: float = 400.0
    job_ttl_seconds: int = 1800
    # v1.4.1 — hard ceiling on a single analysis job's wall-clock runtime.
    # Without this, a stage with no per-call timeout headroom (e.g. several
    # sequential Overpass fetches in the buildability stage, each up to ~150s
    # worst-case across 3 mirror failovers) can leave a job "running" for
    # 10-15+ minutes with the UI frozen at one progress percentage. When the
    # ceiling is hit, the job is forced to a terminal "timeout" status so the
    # frontend can stop polling and unlock the chat input.
    job_max_runtime_seconds: int = 240
    # v1.4.2 — per-call timeout for each individual Overpass fetch inside the
    # buildability stage. The stage previously made up to 6 sequential calls
    # with no individual call ceiling, meaning one slow Overpass mirror (up to
    # ~50s per endpoint × 3 mirrors = ~150s) could consume the entire 240s
    # analysis budget before the hard job ceiling even fired. 30s caps any
    # single buildability call; on timeout the check degrades gracefully
    # (empty mask, confidence note) rather than failing the whole analysis.
    buildability_overpass_timeout: int = 30
    # v1.5.2 — TOTAL wall-clock budget for the entire buildability stage. The
    # v1.4.2 per-call cap bounded each fetch but not their SUM: up to 6 fetches
    # x 30s could still stack to ~180s and blow the 240s job ceiling (observed
    # live on 2 of 4 canonical prompts). Fetches now run concurrently (bounded
    # by buildability_fetch_concurrency) under this single stage deadline; any
    # fetch that cannot start/finish inside the remaining stage budget degrades
    # (empty mask + note) instead of failing the job. Worst case stage cost is
    # now min(this budget, ceil(n_fetches/concurrency) x per-call timeout).
    buildability_stage_budget_seconds: int = 90
    # Max concurrent buildability Overpass fetches. Kept low deliberately:
    # public Overpass mirrors allow ~2 connection slots per IP; more parallelism
    # trades timeout risk for 429 risk. 2 halves-to-thirds the worst-case stage
    # wall clock without exceeding mirror etiquette.
    buildability_fetch_concurrency: int = 2

    # ── v1.6.0 (Phase 3) — server-side identity + quota enforcement ─────────
    # OFF by default (rollout-safe: deploy code first, flip the flag once the
    # token-sending frontend is live). When ON, /api/v2/chat verifies identity
    # and /api/v2/analyses verifies identity AND transactionally consumes one
    # analysis credit from Firestore users/{uid}.promptsUsed. Fail-closed.
    require_user_auth: bool = False
    # Analyses included per account. Set to 5 for the paid ₹50,000 tier via
    # env MAX_PROMPTS_PER_USER=5; keep in sync with the frontend
    # MAX_PROMPTS_PER_USER and the firestore.rules cap.
    max_prompts_per_user: int = 10
    # Comma-separated admin emails that bypass the quota. MUST stay in sync
    # with the isAdmin() allowlist in firestore.rules.
    quota_admin_emails: str = "abhishek.rawat@stratageo.in,sagar.mysorekar@stratageo.in"
    # v1.6.1 — max conversational (non-consuming) chat turns per user per
    # rolling hour. Generous for real spec refinement; a hard stop for scripts
    # looping the LLM endpoint on someone else's OpenAI bill.
    chat_turns_per_hour: int = 60
    # v1.4.6 — per-call ceiling for every OPTIONAL provider call OUTSIDE the
    # buildability stage (Google Places, water/corridor geometry, isochrones,
    # traffic catchments, route targets, railway barriers). The v1.4.2 fix only
    # covered buildability; live supermarket testing still hit the 240s job
    # ceiling because the remaining stages could each stack ~30-180s of
    # un-capped provider latency. On timeout each check degrades (default
    # value + note + confidence reduction) instead of killing the job.
    optional_provider_timeout: int = 45
    # The main combined OSM fetch is critical (all layer data in one query) so
    # it gets a generous ceiling — but still bounded well below the 240s job
    # cap so a hung Overpass mirror can't consume the whole budget before the
    # degradation path ("OSM layers scored as zero") gets a chance to run.
    main_fetch_timeout: int = 120

    # ── Feature flags (v1.1.0+) ──────────────────────────────────────────────
    enable_raw_intent_parser: bool = True       # deterministic pre-LLM parser
    enable_universal_archetypes: bool = True    # archetype registry
    enable_multi_score_output: bool = True      # rank + viability + confidence
    enable_universal_critic: bool = True        # upgraded critic contract

    # ── v1.2.0: Deterministic planning mode ──────────────────────────────────
    # When true, structural spec fields (factor keys, weights, catchment) are
    # locked to canonical archetype schemas; LLM is for explanation only.
    stratageo_deterministic_planning: bool = True
    # Temperature for spec-building LLM calls (0 = greedy, most reproducible).
    stratageo_spec_temperature: float = 0.0
    # Stable seed for spec-building calls where supported by the API.
    stratageo_spec_seed: int = 42

    # ── v1.3.0: Evidence Trail ─────────────────────────────────────────────────
    # When true, every completed analysis includes a full EvidenceTrail in the
    # result payload and the /evidence endpoint is active.
    enable_evidence_trail: bool = True

    # ── v1.4.8: Google Places API (New) / Aggregate / Routes integration ──────
    # Analysis-critical features default ON (they self-disable without a key
    # and degrade to legacy Places / OSM / ORS on failure). UI-only or
    # cost/attribution-sensitive features default OFF until wired safely.
    enable_google_places_new: bool = True          # Nearby/Text Search (New) as primary POI source
    enable_google_places_aggregate: bool = True    # Aggregate counts for top-K candidate refinement
    enable_google_place_details_new: bool = True   # capped evidence-POI enrichment (rating/price)
    enable_google_place_photos: bool = False       # UI-only; never in scoring
    enable_google_autocomplete: bool = False       # frontend UX only; never in backend scoring
    enable_google_search_along_route: bool = False # provider capability; no product trigger yet
    enable_google_routes_validation: bool = True   # Google Routes primary for route constraints (ORS fallback)
    enable_google_ai_summaries: bool = False       # narrative-only; region availability varies

    # Timeouts / budgets for the v1.4.8 provider layer.
    google_places_timeout_seconds: float = 12.0
    google_places_max_retries: int = 2             # bounded; retryable 429/5xx/network only
    google_places_total_budget_seconds_per_job: float = 45.0
    google_places_aggregate_timeout_seconds: float = 12.0
    google_routes_timeout_seconds: float = 15.0
    google_details_max_places_per_job: int = 6
    google_photos_max_places_per_job: int = 3

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]

    # ── Resolved model names (respect legacy aliases) ─────────────────────────
    @property
    def effective_chat_model(self) -> str:
        return self.chat_model or self.stratageo_chat_model

    @property
    def effective_reasoning_model(self) -> str:
        return self.stratageo_reasoning_model

    @property
    def effective_critic_model(self) -> str:
        return self.critic_model or self.stratageo_critic_model

    @property
    def effective_report_model(self) -> str:
        return self.explain_model or self.stratageo_report_model

    @property
    def effective_fast_model(self) -> str:
        return self.stratageo_fast_model

    @property
    def effective_escalation_model(self) -> str:
        return self.stratageo_escalation_model or self.effective_chat_model

    @property
    def cost_mode(self) -> str:
        return self.stratageo_max_llm_cost_mode

    @property
    def critic_active(self) -> bool:
        """Critic runs when enabled AND cost mode allows it."""
        if not self.critic_enabled:
            return False
        return self.cost_mode in ("balanced", "high")

    def feature_flags(self) -> dict:
        return {
            "rawIntentParser":       self.enable_raw_intent_parser,
            "universalArchetypes":   self.enable_universal_archetypes,
            "multiScoreOutput":      self.enable_multi_score_output,
            "universalCritic":       self.enable_universal_critic,
            "modelEscalation":       self.stratageo_enable_model_escalation,
            "deterministicPlanning": self.stratageo_deterministic_planning,
            "evidenceTrail":         self.enable_evidence_trail,
        }

    def model_config_public(self) -> dict:
        """Model names exposed via /health — never secrets."""
        return {
            "chatModel":       self.effective_chat_model,
            "reasoningModel":  self.effective_reasoning_model,
            "criticModel":     self.effective_critic_model,
            "reportModel":     self.effective_report_model,
            "fastModel":       self.effective_fast_model,
            "escalationModel": self.effective_escalation_model if self.stratageo_enable_model_escalation else None,
            "escalationEnabled": self.stratageo_enable_model_escalation,
            "fallbackEnabled": self.stratageo_enable_model_fallback,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
