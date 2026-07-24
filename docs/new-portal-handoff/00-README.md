# StrataGeo → New Portal — Technical Handoff Package

> **This package describes the OLD portal. It is not the new architecture.**
> It exists so a fresh Claude Code session, working in a brand-new repository
> with new infrastructure, can understand the current portal's proven
> spatial-analysis engine, avoid its historical complexity, and design a clean,
> independent, **LLM-led MCDA** portal.

## Documented source state

```text
Repository:            AiM0-create/stratageo-site-suitability-portal
Branch:                master
HEAD SHA:              ecd4c581c49932c3d71246fbaf75d618ed6c244b
Working tree:          clean (no uncommitted changes)
Application version:   1.8.0  (package.json, backend-py/app/config.py APP_VERSION)
Backend engine version: stratageo-engine-00070  (config ENGINE_VERSION; live
                        revision reports K_REVISION, e.g. stratageo-engine-00070-92f)
Release name:          "Screening & Investigation-Zone Product Contract"
Public spec version:   2.3  (config SPEC_VERSION — see discrepancy note below)
Evidence version:      1.4.0
Documentation generated on: 2026-07-15
```

The documented code is exactly `HEAD` (the working tree is clean). Everything
in this package was cross-checked against the source at `ecd4c58`.

**Discrepancy to be aware of:** the `/health` endpoint and reports advertise
`SPEC_VERSION = "2.3"` (a decoupled marketing/compat constant in
`config.py`), but the pydantic model `SpecV2.version` is
`Literal["2.0","2.1","2.2"]` defaulting to `"2.2"`. The two version strings
are intentionally independent; the new portal should collapse them into one.

## Authoritative-source statement

**When documentation and code disagree, the code at `ecd4c58` is the source
of truth.** Disagreements found during extraction are recorded inline (see
`01-CURRENT-SYSTEM-OVERVIEW.md` §Documentation inventory). Nothing in the
`docs/archive/` directory is authoritative — it is superseded history.

## Reading order

| # | File | Read it to learn |
|---|------|------------------|
| 00 | `00-README.md` | This orientation (you are here) |
| 01 | `01-CURRENT-SYSTEM-OVERVIEW.md` | What the product does; frontend + backend module maps; doc inventory |
| 02 | `02-END-TO-END-EXECUTION-FLOW.md` | The full request→zones sequence, plus the essential spatial core |
| 03 | `03-LLM-AND-DETERMINISTIC-CONTROL-BOUNDARY.md` | **Most important for the new planner.** Exactly what the LLM controls today and what overrides it |
| 04 | `04-MCDA-AND-SPATIAL-ENGINE.md` | Factor schema, raw values, normalization math, weighted composite, target-band, missing-data semantics, candidate selection |
| 05 | `05-DATA-PROVIDERS-AND-MISSING-DATA.md` | Provider matrix, auth, env vars, observed-zero vs unavailable |
| 06 | `06-SPATIAL-SAFEGUARDS.md` | Every mask/gate/guard, classified MVP-essential / later / do-not-port |
| 07 | `07-API-AND-DATA-CONTRACTS.md` | Endpoints and the key data contracts with reduced examples |
| 08 | `08-DEPLOYMENT-AND-INFRASTRUCTURE.md` | Current deployment + a recommended clean independent setup |
| 09 | `09-REUSE-EXTRACT-REWRITE-MATRIX.md` | Which code to copy, which ideas to rewrite |
| 10 | `10-YAGNI-DO-NOT-COPY.md` | Explicit exclusion list with the justification for each |
| 11 | `11-TESTING-AND-REGRESSION-REFERENCE.md` | Test-suite map, subset to port, the nine behavioural prompts |
| 12 | `12-NEW-PORTAL-MVP-RECOMMENDATIONS.md` | **Read last.** The proposed minimal LLM/deterministic boundary + behavioural invariants |
| — | `extraction-manifest.json` | Machine-readable index for the next session to locate code fast |

## The one-paragraph summary

StrataGeo screens large geographies for site suitability. A conversational LLM
turns a natural-language brief into a draft spec, but a **deterministic
planner then overrides the spec's structure** (factors, weights, catchments,
scoring curves, constraints) from a hardcoded archetype registry — the LLM is
"explanation only" past that point. The engine builds an H3 grid over the
study area, fetches POIs (OSM + Google Places), masks unbuildable/excluded
cells, scores every cell with a two-pass MCDA (fast Euclidean screening, then
isochrone/routing/traffic refinement of the top candidates), and returns
ranked **investigation zones** with per-factor evidence, confidence, and
next-validation actions.

**The new portal keeps the GIS execution engine and the product contract but
replaces the hardcoded archetype registry with LLM-designed MCDA
methodology.** The deterministic planner override (`canonical_archetypes.py`
+ `deterministic_planner.py`) is the single largest thing to *not* copy.
