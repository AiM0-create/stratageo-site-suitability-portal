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

---

# Round 2 — v1.0.3.1 reliability patches (post-test follow-up)

**What failed in the latest test** (`riverfront_fnb`, strict Hooghly prompt):
- The strict riverfront corridor found **no OSM line features** and was **silently skipped** ("gate not enforced — all candidates kept"), so the band wasn't applied.
- A candidate named **"Maidan"** ranked **#1 / 7.6 STRONG** — open ground treated as buildable.
- **Tiretta Bazaar** survived as a raw candidate on **zero-competition whitespace** despite demand 0 / F&B 0.
- The brief said "strictly / along the river" yet the band was the **normal 350 m**, not strict.
- The UI showed **green #1 STRONG pins** while the banner said "No reliable recommendation".

### Changes made (round 2)

**PATCH 1 — riverbank-corridor fallback (no silent skip).** `services/jobs.py`: water geometry is now fetched **once before** the corridor loop and shared with the water mask. When a waterfront corridor finds no river *line*, the engine falls back to the **boundary of the unioned water polygons** (`distance_to_lines_m` measures distance to each polygon ring = the bank) and enforces the band. If **neither** line nor polygon exists, it sets `waterfront_corridor_failed` → `recommendationWithheld=true`, status `insufficient_viable_land` — it never keeps all candidates. New notes: *"river line not found; used water-polygon boundary as riverbank fallback"*, *"Riverfront corridor removed N hexes outside X m band"*, and the old "all candidates kept" note no longer appears for water corridors.

**PATCH 2 — stricter strict band.** `models/spec.py` `_WATERFRONT_STRICT_RE` now also matches **riverside / riverbank / exactly / only / must be along** → strict **250 m**. The engine never auto-widens; if too few viable sites remain it returns `insufficient_viable_land` and suggests widening **250 → 350 → 500** gradually (`_viability_suggestions`). Note added: *"Strict riverfront band selected: 250 m due to 'strictly'/'along river'/'riverside' wording."*

**PATCH 3 — open-space / maidan exclusion.** `engine/buildability.py`: `PROTECTED_AREA_TAGS` extended (`leisure=pitch|garden|common|recreation_ground`, `landuse=village_green|meadow`, `natural=grassland`, …). Added `OPEN_GROUND_NAME_RE` and a **name-based maidan/parade-ground exclusion** (75 m buffer via `point_buffer_mask`) wired into `jobs.py` for commercial briefs (skipped for park-kiosk/open-air use). Reason surfaced: *"Open-space / maidan / park land is not treated as buildable commercial site."* A candidate named "Maidan" is now excluded, not ranked #1.

**PATCH 4 — competition-whitespace capping.** `services/jobs.py` `_cap_competition_whitespace()` (F&B/retail briefs): if **premium demand < 3 AND F&B ecosystem < 3**, the competitor-saturation factor is capped at **3/10**; if **frontage/access < 3**, capped at **4/10**. The composite is recomputed from the capped per-factor scores. Note: *"Competition whitespace capped because demand/F&B baseline is weak."* Tiretta Bazaar no longer gets a strong boost from empty competition.

**PATCH 5/6 — UI + deterministic gate.** When `recommendationWithheld`/`insufficient_viable_land`: map pins render **grey "?" raw markers** ("RAW — NOT RECOMMENDED"), and drawer cards drop the `#rank`/STRONG badge — labelled **"Raw A / Raw B"**, score muted, quality shown as **"Not recommended"**, behind the existing opt-in toggle with a **persistent diagnostic warning**. Per-candidate `riverDistanceM` / `inWaterfrontCorridor` / `buildabilityStatus` / `hardConstraintPass` are computed deterministically; candidates failing the band are excluded before ranking and never counted as recommended.

**Version** bumped to **1.0.3** in `backend-py/app/main.py`, `backend-py/app/routers/health.py`, and `package.json` (frontend topbar reads `__APP_VERSION__`).

### Files changed (round 2)
`backend-py/app/services/jobs.py`, `backend-py/app/models/spec.py`, `backend-py/app/engine/buildability.py`, `backend-py/app/main.py`, `backend-py/app/routers/health.py`, `package.json`, `src/components/ResultsDrawer.tsx` (+ `MapView.tsx` gating from round 1), and tests `backend-py/tests/test_v1031_patches.py`. **93 backend tests pass; frontend `tsc` clean.**

### How the key mechanisms work
- **River-polygon boundary fallback:** the same water polygons used by the water mask are passed (as features) to `corridors.distance_to_lines_m`, which builds LineStrings from each feature's ring and measures hex-centroid distance to the nearest ring — i.e. distance to the riverbank — then `corridor_mask` keeps only hexes within the strict band.
- **Maidan/open-space exclusion:** area tags caught via `centroid_in_polygon_mask`; bare/untagged grounds caught via a name-regex Overpass fetch + 75 m point buffer. Both hard-exclude the *site* only — nearby ghats/parks remain valid demand signals.
- **Competition capping:** a post-rank pass keys off factor names + `direction=negative`; caps the competition score when demand/F&B/frontage baselines are weak and recomputes the weighted-mean composite.

## Hooghly test — exact expectation after this patch (v1.0.3.1)

With the strict prompt, the engine now: selects the **strict 250 m** band ("strictly/riverside" wording); when no river *line* is found, **enforces the band from the water-polygon boundary** (the "all candidates kept" note is gone); **excludes the Maidan / open ground** by tag + name; **caps the zero-competition boost** at Tiretta Bazaar so empty whitespace can't carry a dead area; and **withholds** when fewer than 3 sites clear 5.0/10 inside the band.

**Most likely outcome:** `insufficient_viable_land` — there is very little buildable, non-rail, non-ghat, non-park commercial frontage within 250 m of the Hooghly strictly between the two bridges. The portal returns **"No viable site in the strict 250 m riverfront corridor"**, shows any survivors as **grey "Raw A/B" diagnostic markers (no #rank, no STRONG)** with a persistent "not a recommendation" warning, and suggests **widening 250 → 350 → 500 m while staying between Howrah Bridge and Vidyasagar Setu**. If ≥3 genuine riverfront sites *do* clear the band and score ≥5.0, they are returned as real recommendations. Either way, **Maidan is no longer #1 STRONG**, no candidate sits outside the band, and the map/drawer no longer contradict the banner.
