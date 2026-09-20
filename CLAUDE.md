# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Frontend (repo root):

```bash
npm run dev            # Vite dev server on :5173 (proxies /api → :3000)
npm run build          # tsc --noEmit-equivalent typecheck THEN vite build
npx tsc --noEmit       # typecheck only
npm test               # vitest run (all frontend tests)
npx vitest run src/__tests__/resultNormalizer.test.ts     # single test file
npx vitest run -t "normalizes"                            # single test by name
```

Backend (from `backend-py/`):

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                       # fill in API keys
uvicorn app.main:app --reload --port 8000

python -m pytest -q                        # WHOLE suite — use `python -m pytest`,
                                           # never bare `pytest`: it puts backend-py on
                                           # sys.path so `import app` resolves (CI does this)
python -m pytest tests/test_v149_planner_lite.py -q       # single file
python -m pytest tests/test_scoring.py::test_name -q      # single test
```

`tests/p1_chat_test.py`, `consultant_test.py`, `feasibility_test.py`, and `staged_flow_test.py` are **manual scripts that hit live APIs** — they are not collected by pytest and must not be turned into unit tests.

Deploy: frontend is automatic (push to `master` → GitHub Actions → gh-pages). Backend is manual:

```bash
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project <project>
```

Bare `--source` deploys preserve the existing service config (`--max-instances 1`, `--no-cpu-throttling`, Secret Manager bindings) — do not re-pass those flags. Tag `rollback-pre-vX.Y.Z` at the live commit before every backend deploy (see README § Rollback).

## Architecture

Two deployables, one contract (`SpecV2`).

**Frontend** — React 19 + Vite static SPA on GitHub Pages. **Backend** — Python 3.12 FastAPI on Cloud Run, `/api/v2/*`.

Live request flow (`config.isConversationalMode`, i.e. `VITE_PY_BACKEND_URL` + `VITE_CONVERSATIONAL_MODE=1`):

```
FloatingAssistant → chatService.sendChatTurn  → POST /api/v2/chat       (LLM builds SpecV2)
SpecSummaryCard   → chatService.startAnalysis → POST /api/v2/analyses   (returns jobId)
                  → chatService.pollAnalysis  → GET  /api/v2/analyses/{jobId}
                  → resultNormalizer.normalizeAnalysisResult → App state → MapView / ResultsDrawer
```

The frontend has one flow: brief → `/clarify` → `/chat` (plan) → `/analyses` (run, poll) → map + drawer. **Check a spot** (`components/SpotCheck.tsx` → `POST /api/v2/spot`, `services/spot.py`) is the same engine with `studyArea=point_radius`, res 9 and `spec.targetPoint`; the run reports `result.targetCell` (always re-verified, always described) and the verdict is relative to the cells around the pin — never an absolute score. There is no client-side analysis path; `services/pdfReport.ts` renders the PDF from the result payload on a small layout kit (`Doc`: wrap/fit measure at the size they draw; tables wrap; blocks are page-break aware) and `services/mapFigure.ts` draws the figures — `basemapZoom` must keep the tile count inside `MAX_TILES` or the basemap silently disappears (the v2.7.0 incident).

### Three layers of intelligence

1. **Conversation** (`services/llm.py`, `services/prompts.py`, `services/clarify.py`) — an LLM turns the brief into a `SpecV2` (models/spec.py). `engine/deterministic_planner.py` then **overwrites the LLM's structural fields** (layers, weights, catchment, study area) from `engine/canonical_archetypes.py`; `engine/factor_composer.py` adds the LLM's `contextFactors` only if they name classes from `engine/feature_classes.py` and quote the customer's words. Every layer carries `origin` + `whyItMatters`. The LLM keeps explanation text, place names, feasibility prose and the context-factor proposals.
2. **Engine** (`services/jobs.py::_run_analysis`, ~3k lines — the orchestrator; every `engine/*` module is called from here) — H3 grid → OSM/Places fetch → spatial masks → Pass A Euclidean scoring → Pass B ORS/Places refinement → route gates → multi-score → viability gate. **No LLM touches scoring math.**
3. **Critic** — `engine/reliability_critic.py` (deterministic, always on). The LLM critic was removed in v2.1.0.

### Job lifecycle

Jobs live in an **in-process dict** in `services/jobs.py`, run on a worker thread, and are polled by the client. This is why Cloud Run must stay at `--max-instances 1 --no-cpu-throttling`. `services/storage.py` snapshots job state and provider caches to GCS so restarts don't hang pollers; it is fail-soft and everything degrades to memory without `GCS_BUCKET`.

### PlannerLite

`engine/planner_lite.py` is a pure deterministic gate run **before** expensive stages; it decides whether water geometry, buildability masks, routing, and Places refinement are relevant to *this* prompt. A skipped stage is a recorded resource decision surfaced as `analysisCompleteness` — never a failure or degradation. Do not add an unconditional provider fetch to the pipeline without routing it through PlannerLite.

## Invariants

These are load-bearing design rules with regression tests behind them; violating one is a product bug, not a style issue.

- **Honesty over completeness.** Missing data is excluded from the composite, never scored 0 or 10. A non-discriminating factor gets neutral 0.5 and a flag. A hard constraint with no data withholds the ranking. Euclidean proximity is never presented as a verified drive/walk time. Rent, floor area, availability, zoning, and ownership are always "unverified — not scored". `engine/constraint_policy.py`, `engine/hard_constraints.py`, and `engine/screening_contract.py` enforce this; `screening_contract.py` is a **projection** — it can rephrase a verdict, never upgrade one.
- **Numeric contract** (`engine/contracts.py`) — no raw provider output or mixed-type diagnostic dict may flow into numeric scoring. Every numeric scoring field is a validated finite float; lists/dicts belong only in evidence/diagnostics fields.
- **Every new SpecV2 field must be declared on the model.** Pydantic silently drops undeclared keys the planner writes (this was the v1.11.0 exclusion bug); `tests/test_v1110_exclusion_integrity.py` fails the build otherwise.
- **All backend results pass through `resultNormalizer.normalizeAnalysisResult()`** before reaching a component. Repair the payload once at that boundary, not with `??` guards scattered through `ResultsDrawer`/`MapView`; repairs surface in `normalizationWarnings`.
- **Weights renormalize preserving ratios**, never per-layer clamping (v1.0.0 postmortem, `models/spec.py`).
- **No Mapbox token in the frontend build.** `vite.config.ts` hard-fails on an `sk.` token; the browser fetches a public `pk.` token at runtime from `/api/v2/map-config`, which withholds anything that isn't well-formed and public. Rotate via the Cloud Run `MAPBOX_TOKEN` env var — no rebuild.
- **Every route that spends money is listed in `security.py::_PROTECTED_PREFIXES`** — a new LLM-calling router that is not added there answers anonymous callers (v2.7.1: `/clarify` and `/spot` shipped that way). `test_v271_security_sweep.py` drives the four routes through the gate; extend it when adding a route. Client-supplied `SpecV2` fields go into Overpass QL and the polyfill — validate charset and size on the model, never in the engine.
- **Cost guards are the point of `security.py` / `auth_quota.py`.** The engine is publicly reachable and spends real money per call. `X-App-Token` is a rotatable kill-switch (it ships in the bundle by design, it is not a secret); the analysis credit is consumed only *after* spec validation, so a malformed spec never burns a customer's quota.
- Provider failures are degradations, not crashes: `_degradable_call` + `ProviderBreaker` in `jobs.py`, reported via `providerDiagnostics` / `maskStats["providerDegraded"]`. Every Google provider flag self-disables to legacy Places or OSM.

## Conventions

- **Versions live in three places and drift on purpose.** `package.json` (frontend, currently ahead) and `backend-py/app/config.py::APP_VERSION` are bumped independently — a frontend-only release does not bump the backend. `ENGINE_VERSION` is a fallback only; `/health` reports the real Cloud Run revision from `K_REVISION`. `SPEC_VERSION`/`EVIDENCE_VERSION_PUBLIC` bump only on an actual contract change.
- **`CHANGELOG.md` is the project's memory** and is written per release with *the live failure that motivated the change*, not just a diff summary. Match that voice. The README describes the portal as it is today and deliberately does not accumulate a section per version.
- Comments in this codebase cite the version and the incident that forced the code (`# v1.4.6 — ...`). Keep that when touching such code; it is how the invariants stay understood.
- Tests are named for the release that motivated them (`test_v1113_sea_mask.py`, `drawerLayout.test.ts`). Add a regression test in that style rather than expanding a generic one. `drawerLayout.test.ts` asserts against `main.css` text because jsdom does not run flex layout — CSS contracts are tested as text.
- **Phone layout is one breakpoint in two places.** `services/phoneLayout.ts::PHONE_MEDIA_QUERY` (React decides sheet vs. drawer) and the `@media (max-width: 640px)` block in `main.css` must agree, and `SHEET_PEEK_PX` mirrors `--sheet-peek`; `mobileLayout.test.ts` asserts the CSS side. Below 640px the results drawer is a bottom sheet (`services/sheetState.ts`) that is never hidden while a result exists.
- `docs/archive/` is a frozen audit trail; `docs/analysis-engine-v1.5-change-log.md` is the living per-change engine log. `docs/STRATAGEO_PORTAL_LATEST_PROJECT_AUDIT.md` explains why the pipeline is shaped the way it is.
- `.github/PULL_REQUEST_TEMPLATE.md` requires pytest + `tsc --noEmit` + `npm run build` output plus the listed smoke prompts.
