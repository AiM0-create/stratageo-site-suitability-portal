# Changelog

All notable changes are documented here. Format: [SemVer](https://semver.org).

---

## [1.1.2] — 2026-06-24 — Water Tag Helper NameError Fix

### Fixed
- **`NameError: name '_is_water_tag' is not defined`** in `services/jobs.py` line 610. The helper `_is_water_tag` is defined in `models/spec.py` but was never imported into `jobs.py`. Any analysis that processed corridor water-tag checks (e.g. QSR cafe near road junction, any non-waterfront brief that still reaches the corridor loop) crashed with this NameError. **Fix:** added `_is_water_tag` to the import at `jobs.py` line 18. One-line change.
- **Trigger prompt:** "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass" — crashed the engine at the corridor loop even with no waterfront corridors.
- 21 new regression tests in `tests/test_water_tag_hotfix.py`.

### Not changed
- Model routing (gpt-5.4-mini / gpt-5.4-nano / gpt-5.4).
- Any spatial mask logic or water/buildability mask behavior.
- No new dependencies.

---

## [1.1.1] — 2026-06-24 — Cost-Aware Model Routing Refresh

### Changed
- **Model defaults updated to gpt-5.4 family** (`backend-py/app/config.py`):
  - `STRATAGEO_CHAT_MODEL`: `gpt-5.4-mini` (was `gpt-4o`)
  - `STRATAGEO_REASONING_MODEL`: `gpt-5.4-mini` (was `gpt-4o`)
  - `STRATAGEO_CRITIC_MODEL`: `gpt-5.4` (was `gpt-4o`)
  - `STRATAGEO_REPORT_MODEL`: `gpt-5.4-nano` (was `gpt-4o-mini`)
  - `STRATAGEO_FAST_MODEL`: `gpt-5.4-nano` (was `gpt-4o-mini`)
  - Escalation in `high` mode may use `gpt-5.5` for critic only (not Pro).
  - **No Pro models used anywhere.**
- Added `STRATAGEO_ENABLE_MODEL_FALLBACK`, `STRATAGEO_FALLBACK_CHAT_MODEL`, `STRATAGEO_FALLBACK_FAST_MODEL` — disabled by default.
- Version bumped: `APP_VERSION`, `ENGINE_VERSION` → `1.1.1`; `package.json` → `1.1.1`.

### Not changed
- Cost mode default still `low`; critic still off in `low` mode.
- All v1.1.0 and v1.0.3 features preserved.
- No dependency changes.

---

## [1.1.0] — 2026-06-24 — Universal Suitability Logic Upgrade

### Fixed (Phase 18 — production blocker)
- **"Uploaded points only" hard constraint now enforced.** Previously, "Only rank my uploaded CSV points" was detected by the parser but ignored by the engine, which ran a full H3 search. Now: (1) if `uploadedCandidatesOnly=True` and points are provided, the engine scores only those points using the MCDA factor framework — no H3 grid search; (2) if no points are provided, execution is **blocked** with a clear user-facing message; (3) `constraintEnforcementLevel` is set to `"enforced"` in all uploaded-only results.
- **Contradictory constraint detection** (`detect_contradictory_constraints()`): unit normalization bug fixed (m vs km were compared without conversion).
- **`validate_hard_constraints_in_spec`** wired as advisory check in `_run_analysis()` (was imported but never called).
- **Critic disclosure**: `criticEnabled`, `constraintEnforcementLevel`, `untracedConstraints` added to result JSON; shown in ResultsDrawer.
- **Cost mode default** corrected from `balanced` to `low` (Phase 16).
- **PDF version disclosure** added (app version, engine version, recommendation mode, site claim level).

### Added
- **Deterministic RawIntent parser** (`engine/intent_parser.py`): extracts output count, business type, geography, hard constraints, spatial relations, and feature classes from the raw prompt before the LLM sees it. Hard constraints that cannot be traced to a SpecV2 gate block execution.
- **Universal archetype registry** (`engine/archetypes.py`): 14 archetypes (QSR, premium restaurant, dark kitchen, clinic, hospital, preschool, gym, retail, warehouse, EV charger, hotel, office, industrial, generic fallback). Each archetype defines factor weights, scoring curves, misleading variables, and minimum viable evidence.
- **Scoring curve types**: `positive_linear`, `negative_linear`, `inverted_u`, `threshold_min/max`, `distance_decay`, `distance_band`, `opportunity_gap`, `complementarity`, `binary_gate`.
- **Multi-dimensional scoring**: `relativeRankScore`, `absoluteViabilityScore`, `confidenceScore` alongside the existing `compositeScore`. Recommendation mode gated on all three.
- **SpecV2 v2.1 extensions** (backward-compatible): `rawIntent`, `analysisMode`, `recommendationMode`, `scoreSemantics`, `modelDisclosure`, `confidence`, `siteClaimLevel`, `output.requestedTopNRaw/topNResolved/topNReason/outputCountWarning`.
- **Cost-aware model routing** (Phase 9): `STRATAGEO_CHAT_MODEL`, `STRATAGEO_REASONING_MODEL`, `STRATAGEO_CRITIC_MODEL`, `STRATAGEO_REPORT_MODEL`, `STRATAGEO_FAST_MODEL`, `STRATAGEO_ENABLE_MODEL_ESCALATION=false`, `STRATAGEO_MAX_LLM_COST_MODE=balanced`. All default to existing production models — zero config change needed.
- **`/health` extended**: returns `appVersion`, `apiVersion`, `engineVersion`, `specVersion`, `releaseName`, `modelConfig`, `costMode`, `featureFlags`.
- **Output count from RawIntent**: default 3, user-specifiable 1–10, cap at 10 with warning. Chat box no longer shows a result-count stepper.
- **Universal critic contract**: returns `shouldWithholdRecommendations`, `recommendationModeOverride`, `downgrades`, `confidenceAdjustment`, `requiredFixes`, `userFacingWarning`.
- **Upgraded recommendation labels**: `RECOMMENDED`, `CANDIDATE_ZONE`, `WEAK_CANDIDATE`, `RAW_DIAGNOSTIC`, `EXCLUDED`, `NO_RELIABLE_RECOMMENDATION` replacing simple STRONG/VIABLE/WEAK.
- **Frontend type extensions**: `AnalysisResult` and `LocationData` carry new v1.1.0 fields. ResultsDrawer shows Rank Score, Absolute Viability, and Confidence alongside composite score.
- `docs/upgrade_backups/V1.1.0_BASELINE.md` — rollback reference.
- `docs/RELEASE_NOTES_v1.1.0.md` — full release narrative.
- `docs/DEPLOYMENT_CHECKLIST_v1.1.0.md` — staging / deployment checklist.

### Changed
- `config.py`: all model names now configurable via env vars; cost-mode tiers control LLM call budget.
- `health.py`: richer version + model metadata.
- `main.py`: version read from `config.APP_VERSION`.
- `services/prompts.py`: universal consultant prompt covering all 14 archetypes, `siteClaimLevel`, `recommendationMode`, and cost-aware output.
- `services/critic.py`: upgraded critic JSON contract with deterministic result application.
- Frontend `FloatingAssistant`: result-count stepper removed; count comes from RawIntent.
- Frontend `ResultsDrawer`: new score columns + recommendation status display.
- Frontend `MapView`: pin colour/glyph driven by `recommendationMode` not just composite score.

### Fixed
- Recommendation language: "Best locations" replaced with "Recommended candidate zones" unless `siteClaimLevel=parcel_site`.
- Competition logic: inverted-U scoring curve; zero competition + weak demand correctly penalised.

### Not changed / preserved
- Existing SpecV2 v2.0 fields: fully backward-compatible — old saved analyses load correctly.
- Cloud Run deployment config: unchanged.
- All v1.0.3 spatial reliability safeguards (waterfront corridor, buildability masks, viability gate, etc.): active and untouched.

---

## [1.0.3] — 2026-06 — Spatial Reliability Upgrade

See `SPATIAL_RELIABILITY_UPGRADE_REPORT.md`.

---

## [1.0.1] — 2026-05 — Conversational Mode

First multi-turn conversational analysis flow.

---

## [1.0.0] — 2026-04 — Initial Release

Single-prompt direct analysis mode.
