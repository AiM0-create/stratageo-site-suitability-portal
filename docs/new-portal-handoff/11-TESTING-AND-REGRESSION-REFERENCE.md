# 11 — Testing and Regression Reference

## Current suite

- **Backend:** `679 passed` (`cd backend-py && pytest tests/ -q`), pytest, ~45
  test files. Deterministic, no live provider calls in the default run
  (providers are mocked/stubbed or the tested code is pure).
- **Frontend:** `90 passed` (`npx vitest run`), 4 test files. Pure-function +
  normalizer tests; no browser/E2E.
- **Typecheck:** `npx tsc --noEmit` clean. **Build:** `npm run build` clean.
- **CI:** `.github/workflows/backend-tests.yml` (pytest). Frontend build runs
  in the Pages deploy workflow.

There are no golden-file provider fixtures for the full pipeline and no live
integration tests in CI — the nine canonical prompts are exercised as
**deterministic contract tests** (planning/fingerprint/detection level), and
manually against live providers (`VNEXT_MANUAL_SMOKE_TEST_GUIDE.md`).

## Backend test groups (by concern)

| Group | Files | Ports to new portal? |
|-------|-------|----------------------|
| **Scoring / MCDA** | `test_scoring.py`, `test_vnext_contract.py` (curve/observed-absence), `test_multi_score.py` | **Directly reusable** (adapt Layer type) |
| **Numeric contract** | `test_v147_contract.py` | **Directly reusable** |
| **Masks / spatial** | `test_water.py`, `test_water_tag_hotfix.py`, `test_buildability.py`, `test_corridors.py`, `test_v162_smart_masks.py`, `test_waterfront_guard.py`, `test_waterfront_v103.py` | **Directly reusable** (module-level) |
| **Grid** | (covered via scoring/results) | Reusable |
| **Confidence / reliability** | `test_v160_phase3.py`, `test_v152_reliability.py`, `test_v14_reliability.py`, `test_critic.py` | Rewrite for new inputs |
| **Screening contract (v1.8.0)** | `test_vnext_contract.py` (verdict/next-validation/scale/follow-up/battery) | **Rewrite for new schema** (keep the assertions' intent) |
| **Planner / archetypes** | `test_v149_planner_lite.py`, `test_v15_intelligence.py`, `test_archetypes_v110.py`, `test_v163_grid_choice.py` | **Irrelevant** (registry replaced) — keep only scale-classification ideas |
| **Deterministic planning / coords / weights** | `test_v164_map_and_coords.py`, `test_spec.py`, `test_spec_v110.py`, `test_intent_parser.py` | Rewrite (parsers become validators) |
| **Constraints / hard-constraint visibility** | `test_hard_constraint_visibility.py`, `test_viability_gate.py`, `test_v1031_patches.py` | Rewrite (ideas reusable) |
| **Routing / traffic** | `test_routing.py`, `test_traffic.py` | Reference (later) |
| **Providers** | `test_v148_google_providers.py`, `test_poi_merge.py` | Reusable (adapt) |
| **Job lifecycle** | `test_job_lifecycle.py`, `test_v146_degradation.py` | Rewrite (new orchestrator) |
| **Evidence / config / smoke** | `test_evidence_trail.py`, `test_config_v110.py`, `test_phase17_smoke.py` | Config reusable; evidence later |
| **Ad-hoc / staged** | `consultant_test.py`, `feasibility_test.py`, `p1_chat_test.py`, `staged_flow_test.py` | Reference only |

## Frontend test groups

| File | Concern | Ports? |
|------|---------|--------|
| `screeningPresentation.test.ts` | exec summary, reasons, risk, rank deltas, comparison, CTA | **Extract with the module** |
| `reweighting.test.ts` | client reweight math + grid ranking | Reusable if reweight is kept |
| `resultNormalizer.test.ts` | payload repair | Rewrite for new contract |
| `analysisFlow.test.ts` | follow-up/confirmation classification | Reusable (ideas) |

## Recommended subset to port first

**Directly reusable (copy + retarget the type):** `test_scoring.py`,
`test_v147_contract.py`, `test_water*.py`, `test_buildability.py`,
`test_corridors.py`, the target-band + observed-absence tests from
`test_vnext_contract.py`, and `screeningPresentation.test.ts`.

**Rewrite for the new schema (keep intent):** confidence merge, screening
verdict + next-validation, three-state result contract, provider degradation.

**Skip:** all archetype-registry, deterministic-planning-override, fingerprint,
auth/quota, admin, PDF, and session tests.

## The nine behavioural prompts (reference contracts, NOT to hardcode)

From `docs/VNEXT_MANUAL_SMOKE_TEST_GUIDE.md`. The new portal must handle these
*behaviours* but **must not hardcode the prompts or their archetypes** — the
LLM designs the methodology, and these become acceptance scenarios that assert
*properties*, not fixed factor lists.

| # | Prompt essence | Property to assert |
|---|----------------|--------------------|
| 1 | Ruby Crossing / EM Bypass student QSR | Stable plan on re-run; **no phantom waterfront** from "EM Bypass" |
| 2 | Hooghly riverside restaurant, between two bridges | Waterfront corridor is a hard gate; no cell in the river; "riverside investigation zones" wording |
| 3 | Sector V 10,000 sq ft supermarket, arterial, rent ≤ ₹20/sq ft | Arterial gate; **rent + floor area staged as next-validation, never passed** |
| 4 | Ballygunge dark kitchen, 10-min drive, outside 1 km of metro | Drive gate ≠ metro exclusion; **route cannot pass without evidence**; traffic-aware or honest free-flow label |
| 5 | South Mumbai gym, exclude Colaba/Worli, then penalize proximity | Exclusions enforced; follow-up = modification (context retained); **rank deltas**; promoted zones **provisional until verified** |
| 6 | JP Nagar 2nd Phase grocery → expand to South Bengaluru | Coordinates/place preserved; **scale transition disclosed**; methodology comparison; no stale corridor |
| 7 | Nagpur warehouse, sparse competitor data | **Observed-zero ≠ unavailable**; confidence drops; competitor-completeness validation action |
| 8 | Pune coffee, weights 0.7/0.3, then reverse | Prompt weights audited; **unmatched factor disclosed**; follow-up modifies; rank delta |
| 9 | Four Kolkata markets (exact coords), "less competition but not zero" | Verbatim coordinates; only the four markets; **target-band competition**; floor area staged for validation |

These map one-to-one to the invariants in `12`. Build them as property-based
acceptance tests with mocked providers so they run in CI.
