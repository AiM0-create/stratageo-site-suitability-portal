# Release Notes — v1.3.0 Evidence Trail & Reproducible Site Selection Reports

**Date:** 2026-06-25
**Branch:** feature/v1.3.0-evidence-trail
**Previous version:** v1.2.0 (Deterministic Planning & Constraint Enforcement Upgrade)

---

## What Changed

### New: EvidenceTrail schema (`backend-py/app/models/evidence.py`)
Full Pydantic v2 schema for audit-grade evidence including:
- `PromptEvidence` — raw prompt, normalized prompt, planning fingerprint, archetype key
- `DataSnapshotEvidence` — snapshot ID, provider mode, freshness warnings
- `StudyAreaEvidence` — geometry hash, H3 resolution, cell counts before/after masks
- `ProviderQueryEvidence` — per-query evidence for OSM, Google Places, ORS (no secrets)
- `FactorEvidence` — per-factor schema with per-candidate raw counts, normalized scores, weighted contributions
- `CandidateEvidence` — per-candidate recommendation status, score breakdown, constraint checks, exclusion reasons
- `ExclusionEvidence` — explicit ledger of every H3 cell batch and candidate exclusion with type, source, and reason
- `ScoringEvidence` — scoring formula, weight sums, normalization details, recommendation status rules
- `RecommendationSummaryEvidence` — topN counts, valid/excluded candidate counts, relaxation options

Secret scrubbing: `safe_dict()` method + `_scrub_secrets()` recursively replaces any key matching `api_key|authorization|token|secret|password` with `"[REDACTED]"`.

### New: Evidence builder (`backend-py/app/engine/evidence_builder.py`)
- `QueryTracker` class — lightweight thread-safe provider query logger
- `build_factor_evidence()` — builds `FactorEvidence` from `LayerScores` + `layer_pois`
- `build_candidate_evidence()` — builds `CandidateEvidence` from `locations`
- `build_exclusion_ledger()` — builds `ExclusionEvidence` from `mask_stats` + excluded locations
- `build_scoring_evidence()` — builds `ScoringEvidence` from spec + scores + mask_stats
- `assemble_evidence_trail()` — assembles full `EvidenceTrail` from all pipeline artefacts

### Updated: `jobs.py` — evidence trail integration
- `QueryTracker` wired into `_run_analysis()`
- OSM Overpass main fetch recorded with feature count + tags
- Google Places backup fetches recorded per layer
- ORS isochrone calls recorded per layer
- Water body geometry fetch recorded
- `assemble_evidence_trail()` called at job completion
- `evidenceTrail` attached to `job.result` as secret-safe dict

### New: API endpoints (`backend-py/app/routers/analyses.py`)
- `GET /api/v2/analyses/{jobId}/evidence` — returns evidence trail for a completed analysis
- `GET /api/v2/analyses/{jobId}/evidence.json` — downloadable JSON file (no secrets)

### Updated: TypeScript types (`src/types/index.ts`)
Full TypeScript interfaces for all evidence trail types: `EvidenceTrail`, `ProviderQueryEvidence`, `FactorEvidence`, `CandidateEvidence`, `ExclusionEvidence`, `ScoringEvidence`.

### New: Evidence Trail section in ResultsDrawer
Collapsible "Evidence Trail" panel with 7 sections:
1. Analysis Identity (version, job ID, archetype, planning fingerprint)
2. Data Sources (provider query table: provider, purpose, feature count, status)
3. Factor Evidence (expandable per-factor table with per-candidate raw/normalized/weighted scores)
4. Candidate Evidence (per-candidate breakdown with top score drivers)
5. Exclusion Ledger (batch and candidate exclusions with source + reason)
6. Scoring Formula (formula description, weight sums, min viable score)
7. Reproducibility (snapshot ID, geometry hash, plan fingerprint, JSON export button)

### Version bump
- `APP_VERSION = "1.3.0"`
- `ENGINE_VERSION = "1.3.0"`
- `RELEASE_NAME = "Evidence Trail & Reproducible Site Selection Reports"`
- `package.json version: "1.3.0"`

---

## What Did NOT Change

- Model routing defaults: `gpt-5.4-mini / gpt-5.4 / gpt-5.4-nano` unchanged
- Deterministic planning from v1.2.0: still active, not weakened
- `SPEC_VERSION` remains `"2.2"` (no new spec fields)
- All 257 v1.2.0 passing tests still pass
- No production deployment until PR reviewed and merged

---

## Reproducibility Posture

| Level | v1.2.0 | v1.3.0 |
|---|---|---|
| Deterministic planning | ✅ | ✅ |
| Audit reproducibility | ❌ | ✅ |
| Full data replay | ❌ | ❌ (future) |

---

## Tests

- 36 new tests in `test_evidence_trail.py`
- 34 pass, 2 skip (expected — `openai` not installed in unit-test env)
- All 257 pre-existing non-openai tests continue to pass
- 1 pre-existing failure: `test_is_water_tag_importable_via_jobs` (openai import in test env — not caused by v1.3.0)

---

## Files Changed

**Backend:**
- `backend-py/app/models/evidence.py` (NEW)
- `backend-py/app/engine/evidence_builder.py` (NEW)
- `backend-py/app/services/jobs.py` (updated)
- `backend-py/app/routers/analyses.py` (updated)
- `backend-py/app/config.py` (version bump + `enable_evidence_trail` flag)
- `backend-py/tests/test_evidence_trail.py` (NEW)
- `backend-py/tests/test_config_v110.py` (version assertion updated)

**Frontend:**
- `src/types/index.ts` (EvidenceTrail types added)
- `src/components/ResultsDrawer.tsx` (Evidence Trail section added)
- `package.json` (version bump)

**Docs:**
- `docs/V1.3_EVIDENCE_TRAIL_AUDIT.md` (NEW)
- `docs/V1.3_EVIDENCE_SCHEMA.md` (NEW)
- `docs/V1.3_REPRODUCIBILITY_LIMITATIONS.md` (NEW)
- `docs/RELEASE_NOTES_v1.3.0.md` (NEW)
- `docs/DEPLOYMENT_CHECKLIST_v1.3.0.md` (NEW)
