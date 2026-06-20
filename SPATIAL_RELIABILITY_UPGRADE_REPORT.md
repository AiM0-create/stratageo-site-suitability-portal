# Spatial Reliability Upgrade v1.0.3

**Goal:** make the existing StrataGeo framework spatially smarter and more reliable for waterfront / riverside / between-landmark prompts — **without** rewriting the app, removing the conversational flow, or replacing the MCDA framework. All changes are additive deterministic safeguards.

**Branch:** `v1.0.2` (the live engine). The stale `master`/`api/*.js` tree was **not** touched.

**Status:** implemented; `84/84` backend tests pass; frontend `tsc --noEmit` clean.

---

## Files changed

### Backend (`backend-py/app/`)
| File | Change |
|---|---|
| `models/spec.py` | Deterministic `detect_waterfront()` (keyword + strict/broad tiering → 250/350/500 m); `WaterfrontMeta` model + `SpecV2.waterfront`; rewrote the waterfront guard to **clamp** loose water corridors (not just inject), apply the strictest width, mark them `required` hard gates. |
| `engine/buildability.py` **(new)** | Railway/ghat/heritage/open-space tag sets + masks: `centroid_in_polygon_mask`, `line_buffer_mask`, `point_buffer_mask`, and a soft `commercial_viability` frontage proxy. |
| `engine/water.py` | Added `water_overlap_mask()` — area-overlap test (hex masked when >30% of its area is water), complementing the centroid test. |
| `engine/data_osm.py` | Added `fetch_named_features()` (name-regex Overpass query) for ghats; best-effort (never hard-fails the run). |
| `services/jobs.py` | Wired it all: corridor before/after + width/source notes; §4d area-overlap water mask; §4e buildability masks (gated to waterfront/commercial briefs); §8b deterministic geographic critic (per-candidate `riverDistanceM`, `inWaterfrontCorridor`, `buildabilityStatus`, `exclusionReasons`, `hardConstraintPass`); viability gate (`_min_viable_score`, `recommended` flag, `analysisStatus`, suggestions); graceful **insufficient_viable_land** instead of crashing when no hex survives; new result fields (`analysisStatus`, `suggestions`, `maskStats`, `studyAreaBoundary`, `waterfront`). |
| `services/archetypes.py` | New `riverfront_fnb` archetype — riverfront adjacency / frontage / F&B ecosystem / competition penalty / tourist footfall, with affluence as *supporting only*. |
| `services/prompts.py` | Extended P7f: keep the water corridor tight, and a riverfront-F&B factor structure so the LLM stops leading with affluence. |

### Frontend (`src/`)
| File | Change |
|---|---|
| `types/index.ts` | Optional fields on `AnalysisResult` (`analysisStatus`, `suggestions`, `maskStats`, `studyAreaBoundary`, `waterfront`) and `LocationData` (`recommended`, `riverDistanceM`, `inWaterfrontCorridor`, `buildabilityStatus`, `exclusionReasons`, `hardConstraintPass`). All optional → existing UI unaffected. |
| `components/MapView.tsx` | Markers rendered as grey **"raw — not recommended"** pins when `recommendationWithheld`; new study-area (AOI) boundary outline layer. |
| `components/ResultsDrawer.tsx` | `insufficient_viable_land` notice; per-mask "hexes removed by safeguard" breakdown; "what to relax next" suggestions; **"Try widening riverfront corridor to 500 m"** button (re-runs keeping the same geography). |
| `App.tsx` | Passes `recommendationWithheld` + `studyAreaBoundary` to the map; wires `onWidenCorridor` to a chat re-run that widens the band but preserves the area. |

### Tests (`backend-py/tests/`)
`test_buildability.py`, `test_waterfront_v103.py`, `test_viability_gate.py` (new) + a `water_overlap_mask` case in `test_water.py`. **+16 tests, 84 total, all green.**

---

## Logic added (by phase)

**Phase 1 — corridor enforcement.** Waterfront briefs can never run a water corridor wider than the tier width (strict `strictly`/`along the river` → **250 m**, normal → **350 m**, explicit "up to 500 m" → **500 m**). A loose LLM corridor (e.g. the 5000 m "Within Hooghly River corridor" from the audit) is **clamped**, not skipped; a tighter LLM/user corridor is never loosened; water corridors become `required` hard gates. Notes report width, source (injected/clamped/llm) and hex count before→after.

**Phase 2 — buildability masks.** For waterfront + commercial briefs, hard-exclude obvious no-build land: railway polygons + 40 m track buffer; 50 m around named ghats; heritage/protected/sacred/park/open-space polygons. Plus the area-overlap water mask (>30%). A soft commercial-frontage proxy flags candidates `viable`/`weak`. OSM gaps mean "unknown", never "buildable" — we only mask where OSM positively marks no-build land, and every removal is reported.

**Phase 3 — viability gate.** Min recommended score (default 4.5; premium/commercial/strict-corridor 5.0). For waterfront/strict briefs, fewer than `topN` viable sites → `insufficient_viable_land` with relaxation suggestions instead of forcing weak picks. Normal briefs are unchanged (no new withholding on score alone).

**Phase 4 — riverfront archetype.** `riverfront_fnb` playbook + prompt rule so the LLM builds riverfront adjacency / frontage / competition factors and treats affluence as supporting.

**Phase 5 — deterministic critic.** Per-candidate GIS facts (river distance, in-corridor, buildability, exclusion reasons, hard-constraint pass) computed from real geometry and enforced — a waterfront candidate outside the band is excluded here even if it slipped the corridor, independent of the LLM critic.

**Phase 6 — UI.** Withheld pins are grey "raw candidates", AOI boundary is drawn, the drawer shows why-withheld + per-mask removals + concrete relaxations + a one-click widen-and-rerun.

---

## Known limitations / still approximate

- **OSM completeness.** Railway/ghat/heritage/frontage coverage varies across Indian cities. Masks fire only on positively-tagged land; the commercial proxy is intentionally lenient (a confidence signal, not a gate). Real parcel/zoning/frontage data is still absent — flagged for site visit.
- **Masks are centroid/overlap-based.** Hex-level resolution (res 9 ≈ 0.1 km²); sub-hex frontage is not modelled.
- **`riverDistanceM`** is distance to the water-body *outline* from `fetch_area_geometries`, a good bank proxy (not a surveyed shoreline).
- **Strictness detection** reads the LLM `objective`+`businessType`; if the model drops "strictly" from its restatement, the brief is treated as `normal` (350 m) — still far tighter than the old 5000 m.
- **Archetype factor weights** are authored by the LLM (guided by the playbook), not hard-coded — the deterministic gates are the guarantee, the archetype is the nudge.

---

## Manual test checklist

**Test 1 — Hooghly riverside (the failing case)**
Prompt: *"Identify the 3 best sites for a premium riverside restaurant along the Hooghly River, strictly between the Howrah Bridge and Vidyasagar Setu."*
- [ ] No candidates floating in water (centroid + >30% overlap masks).
- [ ] Corridor reports a tight band (≈250 m), **not** "masked 0 hexes beyond 5000 m"; if the LLM emits a loose corridor it is clamped (note: "Waterfront corridor clamped from 5000 m to 250 m").
- [ ] Howrah Maidan / Tiretta Bazaar excluded if outside the 250 m band (`inWaterfrontCorridor=false`, `hardConstraintPass=false`).
- [ ] Railway/ghat/heritage/open-space hexes removed (see `maskStats`).
- [ ] If < 3 viable sites: `analysisStatus = insufficient_viable_land`, no forced weak picks, suggestions shown, map pins grey "raw".
- [ ] Suggestions keep the area between Howrah Bridge and Vidyasagar Setu (widen band, not geography).

**Test 2 — Normal non-waterfront** *"Find good cafe locations in Salt Lake Sector V, Kolkata."*
- [ ] No waterfront corridor, `waterfront = null`, normal ranking shown (no new withholding).

**Test 3 — Metro + avoid railway** *"Find a QSR near metro stations in Delhi but avoid railway land."*
- [ ] Metro proximity still a positive factor; railway land excluded (`railwayRemoved > 0`).

**Test 4 — Explicit 500 m** *"Find a premium restaurant near the riverfront in Kolkata, can consider up to 500 m from the river."*
- [ ] Band = 500 m (broad tier); water/rail/ghat/heritage/open-space still excluded.

---

## Hooghly test — exact expectation after this patch

The engine now hard-gates candidates to a ~250 m riverfront band (clamping the LLM's loose corridor), drops water/rail/ghat/heritage/open-space land, and refuses to recommend sites below 5.0/10. Howrah Maidan and Tiretta Bazaar — inland and/or on rail/ghat land — no longer survive. If too little buildable bank remains between the two bridges, the portal returns **"No viable site in the strict 250 m riverfront corridor"** with grey raw-candidate pins and the suggestion to **widen the band to 500 m while staying between Howrah Bridge and Vidyasagar Setu** — never silently widening the user's geography, never fabricating a winner.
