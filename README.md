# Stratageo Site Suitability Portal

> **Live portal:** [aim0-create.github.io/stratageo-site-suitability-portal](https://aim0-create.github.io/stratageo-site-suitability-portal/)

Say what you are opening and where. The portal asks the two or three things it
needs, agrees the factors with you, then scores the area from map data and
returns **Priority 1…N** zones on a map — each with the factors behind it, the
reason each factor is there, what was observed, and the next thing to check on
the ground.

Outputs are screening-level **zones to investigate** (H3 hexagons, ~0.7 km²),
never exact parcels or sites. Rent, floor area, availability, zoning and
ownership are never scored — they are listed as things to confirm.

---

## The flow

```
brief ──▶ clarify ──▶ plan ──▶ run ──▶ zones
```

| step | what happens | who decides |
|---|---|---|
| **clarify** | Up to three questions: *where exactly*, *what kind of business*, and — only when the brief hints at it — *keep away from / must be near / what we can't check*. Every question is optional. | the AI asks; the engine validates every question and owns what each answer means |
| **plan** | The business family's framework factors (demand, competition, access, co-tenancy) plus 0–4 **context factors** composed from the customer's own words. Every factor carries a one-line reason and, for context factors, the words it rests on. Weights and directions are editable; a factor can be added or removed. | the engine installs; the AI proposes context factors from a closed vocabulary of things the engine can count |
| **run** | One OpenStreetMap query + Google Places for consumer POIs → every cell scored → hard exclusions (rail, water, named places, the brand's own outlets) → the top 12 screening cells re-verified with isochrones, Places aggregates and traffic-aware routing → top N ranked. | deterministic; no LLM touches scoring |
| **zones** | Map coloured by screening score (one basis for every cell); numbered pins for the verified ranking; a card per zone. | — |

---

## Architecture

Two deployables, one contract (`SpecV2`).

```
Browser (React 19 + Vite, GitHub Pages)          Engine (Python 3.12 FastAPI, Cloud Run, 1 instance)
────────────────────────────────────────          ─────────────────────────────────────────────────
FloatingAssistant ── POST /api/v2/clarify ──▶  services/clarify.py      LLM asks, engine validates
                  ── POST /api/v2/chat ─────▶  services/llm.py          LLM drafts, planner overrides
                                                 engine/deterministic_planner.py + factor_composer.py
SpecSummaryCard   ── POST /api/v2/analyses ─▶  services/jobs.py         worker thread, in-process job
                  ── GET  /api/v2/analyses/{id} (poll)
resultNormalizer ◀── result ──────────────────  engine/scoring.py, results.py, reliability_critic.py
MapView + ResultsDrawer
```

**Three layers of intelligence**

1. **Conversation** — an LLM turns the brief into a `SpecV2`. `engine/deterministic_planner.py` then overwrites every structural field (layers, weights, catchments, grid, top-N) from the framework registry, and `engine/factor_composer.py` adds validated context factors. The LLM keeps explanation text and the context-factor proposals; it never chooses weights or data sources.
2. **Engine** — `services/jobs.py::_run_analysis`: H3 grid → OSM/Places fetch → masks → Pass A screening → Pass B refinement (shortlist only) → ranking. `engine/planner_lite.py` decides which paid/slow stages are relevant to the brief before they run.
3. **Critic** — `engine/reliability_critic.py`, deterministic and always on. It can withhold a recommendation; it can never upgrade one.

**Invariants** (each has a regression test): missing data is excluded, never scored 0 or 10; a hard constraint with no data withholds the ranking; every SpecV2 field is declared on the model (Pydantic drops undeclared keys silently); weights renormalise preserving ratios; no Mapbox token in the frontend build; a customer's analysis credit is consumed only after the spec validates.

---

## Local development

```bash
# engine
cd backend-py
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in keys
uvicorn app.main:app --reload --port 8000
python -m pytest -q             # always `python -m pytest`, never bare `pytest`

# portal
npm ci
cp .env.example .env.local      # VITE_PY_BACKEND_URL=http://localhost:8000
npm run dev                     # :5173
npm test && npx tsc --noEmit && npm run build
```

`backend-py/tests/p1_chat_test.py`, `consultant_test.py`, `feasibility_test.py` and
`staged_flow_test.py` hit live APIs and are not collected by pytest.

---

## Configuration

**Frontend** (Vite build-time; set as GitHub Actions env/secrets for the Pages deploy)

```
VITE_PY_BACKEND_URL    # engine base URL
VITE_APP_TOKEN         # X-App-Token kill-switch — ships in the bundle by design, not a secret
```

There is deliberately no Mapbox token in the frontend. The map fetches a public
`pk.` token at runtime from `/api/v2/map-config`; rotate it on Cloud Run alone.

**Engine** (Secret Manager on Cloud Run; `.env` locally)

```
OPENAI_API_KEY
GOOGLE_PLACES_API_KEY
ORS_API_KEY
APP_SHARED_TOKEN
MAPBOX_TOKEN                     # public pk. token; a secret sk. token is refused

STRATAGEO_CHAT_MODEL             # default gpt-5.4-mini
STRATAGEO_REASONING_MODEL        # default gpt-5.4-mini
STRATAGEO_MAX_LLM_COST_MODE      # low (default) | balanced | high

ENABLE_GOOGLE_PLACES_NEW         # default true — each Google flag self-disables to OSM if the API is off
ENABLE_GOOGLE_PLACES_AGGREGATE   # default true
ENABLE_GOOGLE_ROUTES_VALIDATION  # default true
```

Every Google-backed stage is a degradation, never a crash: a provider that
fails or times out is reported in the run's notices and the confidence is
capped.

---

## Deployment

**Frontend** deploys automatically: push to `master` → GitHub Actions → `gh-pages`.

**Engine** is manual. Tag the live commit first, then deploy from source —
the existing service configuration (`--max-instances 1`, `--no-cpu-throttling`,
Secret Manager bindings) is preserved on a bare `--source` deploy:

```bash
git tag -a rollback-pre-vX.Y.Z <live-commit-sha> -m "pre-vX.Y.Z" && git push origin rollback-pre-vX.Y.Z
gcloud run deploy stratageo-engine --source backend-py/ --region asia-south1 --project <project>
curl https://<engine-url>/health      # appVersion, releaseName, live revision, feature flags
```

Rollback: `git checkout rollback-pre-vX.Y.Z -- backend-py/` and redeploy; for
the frontend, push the rolled-back commit to `master`. Do not roll back for a
degraded provider — that is handled by design.

---

## Versions

`package.json` (frontend) and `backend-py/app/config.py::APP_VERSION` (engine)
are bumped independently — a frontend-only release does not bump the engine.
`/health` reports the real Cloud Run revision.

[`CHANGELOG.md`](CHANGELOG.md) is the project's memory: every release with the
live failure that motivated it. `docs/` holds the engine change log and the
architecture audit that shaped the pipeline; `docs/archive/` is frozen history.

---

## License

Proprietary. All rights reserved.
