# Release Notes — v1.2.0 Deterministic Planning & Constraint Enforcement Upgrade

**Date:** 2026-06-24
**Branch:** feature/v1.2.0-deterministic-planning
**Rollback tag:** `backup/pre-v1.2.0-deterministic-planning`

---

## Problem solved

The same prompt submitted in two separate sessions produced materially different specs:
different factor keys, different weights, different candidates, different recommendation statuses.
The Ruby Crossing / EM Bypass QSR prompt was the canonical example: one run returned Ruby Park
as #1; another returned Kushtia excluded with no reliable recommendation.

---

## Root cause

The LLM consultant was acting as both methodology designer and result interpreter. Each
invocation independently invented factor keys and weights from the system prompt, with no
guarantee of producing the same structure twice.

---

## Architecture change

```
BEFORE v1.2.0:
  Prompt → LLM (invents factor keys + weights) → SpecV2 → Engine

AFTER v1.2.0:
  Prompt → RawIntent parser (deterministic)
         → Archetype selection (deterministic)
         → Canonical schema lookup (deterministic)
         → LLM (explanation + study area geocoding ONLY)
         → Deterministic planner override (structural fields)
         → SpecV2 (deterministic) → Engine
```

---

## What is now deterministic

| Field | Before | After |
|---|---|---|
| Factor keys | LLM-chosen (varies) | Canonical schema (frozen) |
| Factor weights | LLM-derived (varies) | Canonical schema (frozen, sum=100) |
| Catchment radii | LLM-varied | Canonical schema (frozen) |
| Archetype selection | LLM override possible | Deterministic parser + registry |
| topN | Enforced after LLM | Enforced before and after |
| temperature | 0.2 | 0.0 (spec calls) + seed=42 |
| planningFingerprint | n/a | Stable hash, same prompt → same hash |

---

## Ruby Crossing prompt — canonical result

**Prompt:** "Find the top 3 locations for a quick-service cafe targeting students near the Ruby crossing and the EM Bypass"

**Canonical archetype:** `student_qsr_cafe`

| Factor | Weight | Direction |
|---|---|---|
| Student catchment proxy | 32 | positive |
| Pedestrian / transit access | 27 | positive |
| Direct cafe competition | 18 | negative |
| Commercial co-tenancy | 14 | positive |
| Dead frontage / barrier penalty | 9 | negative |

This factor table and these weights will be identical every run in v1.2.0.

---

## What remains LLM-assisted (by design)

- Study area place name enumeration and geocoding
- Feasibility explanation text
- Per-factor justification text
- Clarification questions for ambiguous prompts
- Route constraint description wording

The LLM cannot change factor keys, weights, catchment radii, or recommendation status.

---

## New result fields

Every analysis result now includes:
- `planningMode`: "deterministic" | "advisory"
- `planningFingerprint`: stable hash
- `specFingerprint`: structural spec hash
- `constraintEnforcementRecords`: per-constraint enforcement metadata
- `llmSuggestedButNotApplied`: transparency log of LLM weight suggestions that were overridden
- `relaxationOptions`: concrete steps when fewer candidates than requested

---

## Tests

`tests/golden/test_deterministic_planning.py` — 24 golden tests:
- Same prompt × 5 runs → same archetypeKey every run
- Same prompt × 5 runs → same factor keys every run
- Same prompt × 5 runs → same weights every run
- Same prompt × 5 runs → same planningFingerprint every run
- Canonical weights sum to 100 for all 10 archetypes
- student_qsr detection works for plural "students"
- Prompt normalisation idempotent

**Total: 291 backend tests pass / 0 fail.**

---

## Rollback

```bash
git checkout backup/pre-v1.2.0-deterministic-planning
```
