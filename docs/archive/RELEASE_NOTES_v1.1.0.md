# Release Notes — v1.1.0 Universal Suitability Logic Upgrade

**Release date:** 2026-06-24
**Branch:** feature/v1.1.0-universal-suitability-logic
**Rollback:** `git checkout backup/pre-v1.1.0-universal-suitability`

---

## What changed and why

v1.0.3 made the engine spatially reliable for waterfront prompts. v1.1.0 makes it
universally consistent across all site-suitability prompt types — restaurants, dark
kitchens, clinics, hospitals, schools, warehouses, EV chargers, resorts, and more —
without increasing default LLM cost.

### The core problem with v1.0.3

The engine worked well for the Hooghly riverside test once the spatial reliability
patches were applied. But for all other prompt types it still relied entirely on the
LLM to:
- infer the output count from the prompt
- choose factors and weights
- decide whether a candidate is a real recommendation

This meant the quality of results varied widely depending on how the LLM happened to
interpret the prompt on a given run.

### What v1.1.0 does differently

**1. Deterministic parsing before the LLM**

A new `intent_parser.py` module extracts hard constraints, output count, business type,
and spatial relations from the raw prompt using regex + keyword matching — before the
LLM sees anything. The LLM can enrich this but cannot remove hard constraints. If a
hard constraint cannot be traced to a SpecV2 gate (exclusion / corridor / route
constraint / study area rule), execution is blocked.

**2. Archetype registry**

14 business archetypes define the right factor structure for each use case. The LLM
uses the archetype as a playbook rather than inventing weights from scratch. This gives
consistent, defensible results across prompt types.

**3. Three-dimensional scoring**

Instead of one composite score, the engine now computes:
- `relativeRankScore` — how this candidate compares to others in this run (percentile)
- `absoluteViabilityScore` — how viable this site is against archetype benchmarks
- `confidenceScore` — how trustworthy the data is for this candidate

A site only becomes RECOMMENDED when all three are acceptable and the critic passes.

**4. Cost-aware model routing**

All model names are now configurable via env vars. The default is the same set of
models already in production (gpt-4o for chat/critic, gpt-4o-mini for explanations).
A cost-mode tier (`low` / `balanced` / `high`) controls how many LLM calls are made.
Optional escalation to a stronger model is disabled by default.

**5. Honest recommendation language**

The engine now distinguishes between:
- RECOMMENDED — passes all gates, acceptable viability and confidence
- CANDIDATE_ZONE — passes constraints but moderate viability/confidence
- WEAK_CANDIDATE — weak on at least one dimension
- RAW_DIAGNOSTIC — useful for debugging but not a recommendation
- NO_RELIABLE_RECOMMENDATION — constraints fail, data too weak, or geometry fails

The word "best site" only appears in output when `siteClaimLevel=parcel_site`.

---

## What is NOT changed

- All v1.0.3 spatial reliability safeguards are untouched
- Cloud Run deployment configuration is unchanged
- Existing SpecV2 v2.0 saved analyses load correctly
- Default model set is unchanged (no extra API cost on existing deployments)
- The conversational flow, chat UI, and map view are preserved

---

## Rollback

```bash
git checkout backup/pre-v1.1.0-universal-suitability
# redeploy backend and rebuild frontend
```
