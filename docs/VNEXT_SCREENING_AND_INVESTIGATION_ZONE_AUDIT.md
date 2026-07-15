# vNext Audit — Screening & Investigation-Zone Product Hardening

**Baseline:** `master` @ `de8d13a` (v1.7.2 / stratageo-engine-00069), clean tree.
**Baseline verification (before any change):** backend `pytest tests/ -q` → **636 passed**;
`npx tsc --noEmit` → clean; `npx vitest run` → **75 passed**; `npm run build` → clean.
No pre-existing failures; no skipped tests; only pre-existing warnings (a
`datetime.utcnow()` DeprecationWarning in jobs.py and pydantic serializer
warnings in golden tests).

**Living doc.** Updated as the vNext work lands. Each section: requested
behaviour → current implementation (with code evidence) → verdict → change.

**"RP" interpretation:** the term "RP" does not appear anywhere in the
repository (verified by grep). Per the brief's fallback it is treated as the
**Results Presentation layer**: `ResultsDrawer.tsx`, `MapView.tsx`
popups/legend, the PDF generator in `App.tsx` (`handleExportPDF`), and the
shared-analysis view (`/share/:id` route restoring via `analysisStore`).

**Brief assumptions corrected against HEAD:**

| Brief assumption | Reality at HEAD |
|---|---|
| `backend-py/app/jobs.py` | `backend-py/app/services/jobs.py` (2,755 lines, orchestrator) |
| Missing data may become ideal scores | Already impossible: `has_data=False` layers are excluded from the composite (`scoring.pass_a`, `present_weight`); required-missing → ranking withheld |
| Constraints may double as weighted factors | Route gates / corridors / exclusions are masks & eligibility gates, never layers; `_cap_competition_whitespace` guards the one soft interaction |
| No claim-level concept | `siteClaimLevel: "micro_market_zone"` (fixed, never parcel), `point_candidate` for uploads; per-zone `investigationLabel` taxonomy since v1.5 |
| Confidence may default high on failure | `build_unified_confidence` is conservative-min; no-signal default is Medium, never High |
| Reweighted cells may masquerade as verified | Partially guarded since v1.6.7: reweight-promoted cells render as dashed amber "screening basis only" pins; **but** there is no path to re-verify them, and no rank-delta context |
| PDF may be inconsistent with UI | Largely aligned since v1.6.8 (weight audit, constraint checklist, methodology); missing exec-summary/verdict/next-validation/CTA sections |

---

## Gap matrix

Priorities: **P0** misleading/analytically unsafe · **P1** essential for
screening-hook quality · **P2** useful.

| # | Area (brief §) | Current behaviour | Desired | Gap | Planned change | Test |
|---|---|---|---|---|---|---|
| G1 **P0** | Competition target-band (§10) | `Layer.direction ∈ {positive, negative}` only — monotonic; zero competitors ⇒ max score after inversion (softened only by `_cap_competition_whitespace`) | "less but not zero" ⇒ inverted-U | Real | `Layer.scoringCurve: "monotonic"\|"target_band"` + band params; curve applied in `scoring.normalize_layer` path; planner detects the phrasing deterministically; disclosed in justification & methodology | new `test_vnext_contract.py::TestTargetBandCompetition` |
| G2 **P0** | Observed absence ≠ missing data (§3.2) | `has_data = len(pois) > 0` conflates "provider queried OK, zero features" with "provider failed"; both excluded from scoring (conservative, but the distinction is only in prose notes) | Machine-readable three-state | Real (semantics safe, disclosure absent) | `LayerScores.data_status ∈ {observed, observed_zero, unavailable}` set from fetch outcomes; surfaced per factor in `dataQuality[].dataStatus` and criteria evidence; drives next-validation wording ("validate via field recon" vs "provider failed — rerun") | same file, `TestObservedAbsence` |
| G3 **P1** | Screening verdict + claim level (§5.1–5.2) | `investigationLabel` (RECOMMENDED_INVESTIGATION_ZONE/…) + analysis-wide `analysisRecommendation`; `siteClaimLevel` | Restrained per-zone verdict vocabulary + explicit claim level | Mapping only — do **not** duplicate the source of truth | Deterministic map `investigationLabel → screeningVerdict` (Priority/Promising/Conditional/Low priority/Withheld) + `claimLevel` alias of siteClaimLevel emitted per result; UI/PDF use the new vocabulary | `TestVerdictMapping` |
| G4 **P1** | Per-zone next-validation actions (§5.5, §12) | `constraintPolicy.validationChecklist` is analysis-wide, status-phrased, not action-phrased; per-zone actions absent | Concise per-zone action list generated from actual unmet/screening-stage requirements | Real | Backend `build_next_validation()` per zone from: unverifiable constraints, planner unsupported constraints, degraded checks, sparse competition coverage, non-discriminating factors; attach `nextValidation: [...]` per location + analysis-wide | `TestNextValidation` |
| G5 **P1** | Executive result header (§6.1) | Drawer opens with "Ranked Candidate Zones" title, banner, LLM summary, then charts | What screened / output type / top zone / why / confidence / critical next check | Real | New exec-header block at the top of `ResultsDrawer` computed from actual payload values (eligible cell count from hexGrid, top zone, verdict, unifiedConfidence, first next-validation) | vitest normalizer/pure-fn tests |
| G6 **P1** | Zone cards (§6.2) | Card: rank/name/score/badges → LLM reasoning → expandable criteria table | Verdict, 2-3 evidence-backed reasons, key risk, next validation before the factor wall | Real (reorganize, don't destroy) | Compute top evidence reasons (highest weighted factor score with data) & key risk (lowest) deterministically; render verdict + reasons + risk + next-validation on the card; factor table stays in the expander | covered by G4/G3 payload tests |
| G7 **P1** | Reweight verification (§8.2 Option A) | Reweight instant; promoted cells labelled "screening basis"; **no** verify path; no inherited-evidence risk (labels correct) but stuck provisional | Provisional + explicit **Verify adjusted shortlist** | Real | Frontend action submits the current spec with executed custom weights (`weightsAdjustedByUser=true`) as a NEW analysis run (existing `/analyses` machinery — bounded, quota'd); results replace provisional cards | vitest for weight-injection helper; backend already covered by `preserve_user_weights` tests |
| G8 **P1** | Rank-delta comparison (§8.3) | None — reweighted list just re-sorts | prev rank vs new rank, changed weights, newly-introduced flag | Real | Client-side deterministic comparison (original result order vs reweighted order; screening picks vs original shortlist) rendered on cards/screening list | vitest `rankDelta` tests |
| G9 **P1** | Spatial scale (§9) | `analysisIntelligence.locationIntent` (anchor type) + grid-res choice; **no scale class**; catchments/grid fixed per archetype | scale classes affecting methodology + disclosed adaptations | Real (classification + disclosure; grid already user-selectable 7/8) | Deterministic `spatialScale` classifier in `planner_lite._classify_intelligence` (site_or_block/micro_market/locality/city/metro_region/corridor) from study-area size + prompt; surfaced in results + methodology; expansion follow-ups get a methodology-comparison block (frontend compares factor sets/catchments/scale vs previous run in session) | `TestSpatialScale` |
| G10 **P1** | Conversion CTA (§7) | `config.contactUrl` exists; contact link in TopBar/Methodology dialog; share links exist (`analysisStore.shareId`); no results-level CTA | Professional CTA with safe context | Real | Drawer + PDF: "Request Detailed Site Validation" → contactUrl (+ safe `?ref=` analysis shareId when saved) + "Copy analysis summary" action (clipboard, deterministic text); no third-party trackers; no fake checkout | vitest summary-builder test |
| G11 **P2** | Follow-up modification verbs (§8.1) | Server-side deterministic go/framework/affirmation signals; spec-staleness guard on business-type change; waterfront + corridor contamination guards; weight/grid preservation | Also recognize reweight/exclude/expand/compare-style modification intent | Partial | Add `MODIFY_SIGNAL` lexicon in `llm.py` (recalculate/rerank/reweight/reverse/penalize/exclude/expand/…) forcing carry-forward + framework stage; new-brief reset already covers corridors/waterfront/business-type — add named-exclusion + promptWeight carryover clears on business-type reset | backend `TestFollowUpSignals` |
| G12 **P2** | Map semantics (§6.5) | Tooltips say "screening basis", ranks, refined-candidate flags; popup shows raw lat/lng without wording | "Investigation-zone centroid" / "Representative point" phrasing | Cosmetic-real | MapView popup + drawer coord label wording; PDF map caption already says zones | visual (manual guide) |
| G13 **P2** | PDF exec summary + constraint table + next validation + CTA (§6.7) | v1.6.8 PDF: title/verdict badge/summary/notes/criteria/map/weight audit/checklist/methodology | Brief's 10-section structure | Partial | Add exec screening summary block (screened N cells, verdict, confidence), constraint-status table (from hardConstraintVerification), per-zone next validation, CTA footer | manual guide + PDF text builder unit tests where pure |
| G14 **P2** | Docs/versioning (§15–16) | README/CHANGELOG current at 1.7.2 | One consistent story | — | Minor release **v1.8.0** (result-contract + presentation model per repo convention: minor for additive contract changes); README repositioning; CHANGELOG | config version tests |

### Explicitly NOT changed (verified already-solved; brief §17 constraints)

- **Missing data → never an ideal score** — `pass_a` excludes `has_data=False`
  layers; `composite_for_hex` returns `None` when nothing has data
  ([scoring.py:117-149,252-292](../backend-py/app/engine/scoring.py)).
- **Required-but-missing → withhold** — `required_missing_layers` +
  jobs.py required-data gate marks every candidate excluded/scoreWithheld.
- **Constraints are gates** — corridors/exclusions/route constraints mask or
  drop candidates; failing/unevaluable required routes exclude
  ([jobs.py:1913-2120](../backend-py/app/services/jobs.py)).
- **Waterfront honesty** — unenforced corridor ⇒ withhold, never keep-all.
- **Provisional downgrades** — `downgrade_status_for_unverified`,
  `demotes_strong_recommendation` cap, `demoteRecommended` in the drawer.
- **Unified confidence** — conservative-min merge, disagreement explained.
- **Zero-viable honesty** — structured `no_viable_site` payload with failed
  gates + relaxation suggestions that never widen the user's geography.
- **Baseline unbuildable-land mask** (v1.7.2) — always-on; water/wetland/
  forest/military/airfield; candidates cannot sit in lakes.
- **Stale-context guards** — business-type spec reset, waterfront
  false-positive override, corridor contamination strip (v1.7.2), weight &
  grid-resolution preservation.
- **Prompt weights** — quoted + bare forms parsed, audited
  (`weightAudit.adjustedByUser`), unmatched criteria disclosed
  (`promptWeightUnmatched`) — Pune prompt 8 initial turn is covered.
- **Traffic-aware catchments + free-flow labelling** (v1.7.1/v1.7.2).
- **Coordinate fidelity** — `extract_prompt_place_coords` uses verbatim
  coordinates; named/coordinate exclusions never geocode user coords.
- **Numeric contract** — contracts.py scalar coercion; three terminal result
  states; no raw exception reaches the user.

### Architecture notes for implementers

- The wire contract is `results.py` docstring + `src/types/index.ts` +
  `resultNormalizer.ts`. All new fields must be **additive and optional**, with
  normalizer defaults, so saved/shared payloads from ≤1.7.2 keep rendering.
- `constraintPolicy.validationChecklist` (analysis-wide) and
  `hardConstraintVerification.constraints` (per requested constraint) are the
  two existing status structures. G3/G4 must **consume** them, not add a third
  parallel constraint model. The per-zone `nextValidation` list is a
  *projection* of those + run-state, not new state.
- Reweight-verify (G7) reuses the normal run path (`POST /api/v2/analyses`)
  — no new endpoint; costs remain quota'd/budgeted per job.
- Target-band (G1): band bounds are derived at fit time from the observed
  distribution (peak score at the p25–p60 band of nonzero observed counts) —
  no magic absolute counts; raw counts remain untransformed for display;
  log-space (Scoring Standard v1) is respected by applying the curve **after**
  the existing normalize-to-[0,1] step.

## Regression battery mapping (brief §13)

| Prompt | Deterministic contract coverage at HEAD | Added by vNext |
|---|---|---|
| 1 Student QSR | archetype/factor/corridor guards (`test_v15_intelligence`, corridor guard tests) | terminology/claim-level assertions |
| 2 Hooghly riverside | corridor clamp, water mask, withhold tests (`test_v1031_patches`, `test_v162_smart_masks`) | verdict vocabulary («riverside investigation zones») |
| 3 Sector V supermarket | rent/floor unvalidatable (`test_v14_reliability`, feasibility note v1.7.1) | next-validation actions include property/rent verification |
| 4 Ballygunge dark kitchen | strict-route policy, metro exclusion, no-pass-on-missing (`test_v14_reliability`) | constraint-status vocabulary |
| 5 South Mumbai gym | named exclusions (v1.7.1 tests) | follow-up modify-signal + rank-delta unit tests |
| 6 JP Nagar micro→macro | coordinate fidelity, corridor contamination (v1.7.2) | spatialScale classification + methodology comparison |
| 7 Nagpur warehouse | missing-data honesty tests | observed_zero vs unavailable dataStatus |
| 8 Pune weights | prompt-weight parse/audit tests (v1.7.1/v1.7.2) | reweight-verify helper + rank delta |
| 9 Four Kolkata localities | multi-coordinate study area (v1.6.4 tests) | target-band competition |

## Implementation status (v1.8.0 — all gaps closed)

| Gap | Landed as |
|---|---|
| G1 target-band | `Layer.scoringCurve` + `curve_score()`/`normalize_0_1(curve=…)` + `detect_competition_band()`; disclosed in justification/criteria/LLM prompt/PDF/map layers |
| G2 observed absence | `LayerScores.data_status` + fetch-outcome resolution in jobs.py + distinct wording/evidence basis + `dataQuality[].dataStatus` |
| G3 verdicts/claim | `engine/screening_contract.py`: `apply_screening_verdicts` (rank-aware, never-upgrade), `claim_level` |
| G4 next validation | `build_zone_next_validation` + `sparse_competition_factor_names`; per-zone `nextValidation` |
| G5 exec header | ResultsDrawer executive block from `buildExecutiveSummary` (computed only) |
| G6 zone cards | verdict chip, evidence reasons (`topEvidenceReasons`), `keyRisk`, next-check line; factor wall stays in expander |
| G7 reweight verify | "Verify adjusted shortlist" → `handleVerifyAdjustedShortlist` re-runs spec with user weights (audited) |
| G8 rank deltas | `computeRankDeltas` + ▲/▼ was #N chips + NEW — UNVERIFIED badge |
| G9 spatial scale | `planner_lite._spatial_scale` → `analysisIntelligence.spatialScale`; `buildMethodologyComparison` panel |
| G10 CTA | drawer CTA card + copy summary (`buildCopySummary`, prompt-free) + PDF CTA card |
| G11 modify signals | `MODIFY_SIGNAL` / `is_modification_signal` + `NEW_ANALYSIS_RE` context strip in llm.py |
| G12 map semantics | "Investigation-zone centroid (approximate)" tooltips + "Zone centroid:" card label |
| G13 PDF | verdict strip, verdict badges, target-band label, per-zone validation card, constraint-status table, CTA |
| G14 docs/version | v1.8.0 / stratageo-engine-00070; README repositioned; CHANGELOG + engine log + this audit + manual smoke guide (`VNEXT_MANUAL_SMOKE_TEST_GUIDE.md`) |

## Verification log

- Baseline (pre-change): 636 backend / 75 frontend / tsc / build — all green.
- Post-implementation: **679 backend passed** (636 + 43 in
  `test_vnext_contract.py`), **90 frontend passed** (75 + 15 in
  `screeningPresentation.test.ts`), `tsc --noEmit` clean, production build
  clean. No pre-existing test was modified except the version assertions in
  `test_config_v110.py` (1.8.0 / 00070).
