"""v1.6.2 — smart water/buildability relevance, and the timeout/coverage balance.

Root cause (live-observed): "high-end gym in Mumbai" (a bare screening prompt,
zero water/land-development wording) put a recommended candidate on the
Mumbai coastline/dockyard edge and another near Mumbai Port Trust/CSMT
railway land. Two independent gaps combined to cause it:

1. jobs.py's `_buildability_flags()` already correctly flags "gym" as
   commercial (via `_COMMERCIAL_RE`) — but the PLANNER's own relevance gate
   (`_buildability_relevant()`) used a narrower, independently-drifting check
   that did NOT include that regex. Whenever the narrower check said "not
   relevant", jobs.py forcibly zeroed the correctly-computed railway/ghat/
   protected flags, silently dropping no-build-land protection for nearly
   every commercial brief.
2. `_water_relevant()` was pure prompt-text matching with no geography
   awareness: a coastal peninsula city like Mumbai carries real water/dock
   risk even when the prompt itself says nothing about water.

Both are fixed here. Neither reintroduces the buildability-stage timeout
problem (v1.5.2's fix): the stage now runs MORE OFTEN, but each run is still
bounded by the existing stage budget + bounded concurrency + per-fetch
graceful degradation (config.buildability_stage_budget_seconds /
buildability_fetch_concurrency) — those guarantee a bounded worst-case wall
clock regardless of how often the stage fires.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import patch

from shapely.geometry import Polygon as ShapelyPolygon

from app.engine.planner_lite import (
    _buildability_flags,
    _buildability_relevant,
    _water_relevant,
    _spec_text,
    create_analysis_plan,
)
from app.config import get_settings
from app.services import jobs as jobs_mod

from test_v149_planner_lite import _base_spec


def _spec_for(business: str, city: str):
    return _base_spec(
        f"Identify top 3 candidate micro-market zones for a {business} in {city}",
        business,
    )


# ── The exact live-observed failure, fixed ───────────────────────────────────

def test_gym_in_mumbai_triggers_both_water_and_buildability():
    """The screenshot bug: zero water/land-dev wording, but a real gym cannot
    legally sit on port/rail/dock land in a coastal metro like Mumbai."""
    spec = _spec_for("high-end gym", "Mumbai")
    text = _spec_text(spec)
    water, water_why = _water_relevant(spec, text)
    assert water is True
    assert "mumbai" in water_why.lower() or "coastal" in water_why.lower()
    buildability, build_why = _buildability_relevant(spec, text, water)
    assert buildability is True


def test_photography_studio_in_mumbai_triggers_water_purely_from_city():
    """Isolates the geography-only trigger: a business type that matches
    NEITHER the commercial regex nor the land-development regex still gets
    water (and cascaded buildability) protection from the city alone."""
    spec = _spec_for("photography studio", "Mumbai")
    text = _spec_text(spec)
    water, _ = _water_relevant(spec, text)
    assert water is True
    buildability, build_why = _buildability_relevant(spec, text, water)
    assert buildability is True
    assert "waterfront" in build_why or "risk" in build_why


def test_photography_studio_in_landlocked_city_stays_fast_screening():
    """The same neutral business type in a genuinely landlocked city must NOT
    trigger either stage — this is the counterfactual proving the fix is
    geography-aware, not an across-the-board always-on regression."""
    spec = _spec_for("photography studio", "Pune")
    text = _spec_text(spec)
    water, _ = _water_relevant(spec, text)
    assert water is False
    buildability, _ = _buildability_relevant(spec, text, water)
    assert buildability is False


# ── The single-source-of-truth invariant (prevents this class of bug forever) ─

def test_buildability_relevance_never_diverges_from_buildability_flags():
    """For ANY spec, the planner's relevance decision must agree with
    whether _buildability_flags() would actually apply any mask — the two
    can never independently drift again (they're now the same function)."""
    cases = [
        ("high-end gym", "Mumbai"), ("photography studio", "Pune"),
        ("quick-service cafe", "Pune"), ("discount supermarket", "Pune"),
        ("yoga studio", "Bengaluru"), ("bank branch", "Chennai"),
    ]
    for business, city in cases:
        spec = _spec_for(business, city)
        text = _spec_text(spec)
        water, _ = _water_relevant(spec, text)
        buildability, _ = _buildability_relevant(spec, text, water)
        flags = _buildability_flags(spec)
        any_mask = any(flags.get(k) for k in ("railway", "ghat", "protected", "commercial_proxy"))
        # buildability relevance is True whenever water cascades it OR any
        # actual mask would be applied — never a case where flags say "mask
        # this" but the plan says "don't bother running the stage".
        if any_mask:
            assert buildability is True, f"{business} in {city}: flags say mask, plan says skip"


# ── Timeout/coverage balance: broader triggering stays bounded ───────────────

def test_gym_in_mumbai_plan_stays_within_the_existing_stage_budget():
    """Running buildability more often must not blow past the bounded stage
    budget introduced in v1.5.2 — that fix bounds WORST-CASE wall clock
    regardless of trigger frequency (stage budget + concurrency + per-fetch
    degradation), so broadening the trigger here is safe by construction."""
    s = get_settings()
    plan = create_analysis_plan(_spec_for("high-end gym", "Mumbai"))
    assert plan.should_run("buildability")
    assert plan.should_run("water_geometry")
    # The plan's own informational runtime target still respects the hard
    # per-job ceiling — broader triggering doesn't quietly raise it further.
    assert plan.max_runtime_target_seconds <= s.job_max_runtime_seconds
    assert s.buildability_stage_budget_seconds < s.job_max_runtime_seconds


# ── Real wall-clock proof: water + buildability now run CONCURRENTLY ────────
#
# The Mumbai-gym fix means water_geometry AND buildability now BOTH fire for
# the same job (previously a rare combination — now the common case for any
# coastal-metro commercial brief). If they still ran sequentially, that
# combination alone would cost water_fetch + buildability_stage instead of
# max(water_fetch, buildability_stage). This test proves the actual _run_
# analysis code path launches them concurrently, with a real asyncio clock —
# not just that the masks end up applied correctly (the other tests here and
# in test_v149_planner_lite.py already cover that with instant mocks).

def _study_polygon() -> ShapelyPolygon:
    return ShapelyPolygon([
        (72.82, 18.92), (72.85, 18.92), (72.85, 18.95), (72.82, 18.95),
    ])


def _run_pipeline_with_fetch_delay(spec, delay_s: float):
    """Mirrors test_v149_planner_lite._run_pipeline's mock harness, but every
    Overpass area/line/named fetch sleeps `delay_s` — turning fetch COUNT and
    concurrency into a directly measurable wall-clock duration."""
    from app.engine import results as results_mod

    job = jobs_mod.Job(id="60006000-6000-6000-8000-600060006000")
    calls = {"area": 0, "line": 0, "named": 0}

    async def fake_resolve_study_area(area):
        return _study_polygon(), []

    async def fake_fetch_all_layers(tag_sets, bbox):
        return {lid: [{"lat": 18.935 + i * 0.001, "lng": 72.83, "tags": {"name": f"o{i}"}}
                      for i in range(10)] for lid in tag_sets}

    async def fake_pois_with_fallback(types, keyword, bbox, *, legacy_fetch, ctx=None):
        return ([{"lat": 18.936 + i * 0.001, "lng": 72.832,
                  "tags": {"name": f"g{i}", "google_type": "gym"}}
                 for i in range(8)], "google_places_new_nearby", [])

    async def fake_aggregate(center, radius_m, included_types, *, ctx=None):
        from app.providers.base import ProviderResult
        return ProviderResult(provider="gaggregate", feature="insight_count",
                              status="disabled", data={},
                              degradation_reason="api_not_available_http_403")

    async def fake_area(tags, bbox):
        calls["area"] += 1
        await asyncio.sleep(delay_s)
        return []

    async def fake_line(tags, bbox):
        calls["line"] += 1
        await asyncio.sleep(delay_s)
        return []

    async def fake_named(regex, bbox):
        calls["named"] += 1
        await asyncio.sleep(delay_s)
        return []

    async def fake_iso(cells, mode, minutes):
        return {}

    async def fake_geocode(q):
        return (18.935, 72.835)

    async def fake_route_eval(rc, cells, targets, railway):
        return {}

    async def fake_rail(bbox):
        return []

    async def fake_rgeo(lat, lng):
        return "Test Zone"

    async def fake_critique(*a, **k):
        return None

    async def fake_explain(spec_, locations, ds=None):
        return "s", ["r"] * len(locations)

    with patch.object(jobs_mod, "resolve_study_area", fake_resolve_study_area), \
         patch.object(jobs_mod, "fetch_all_layers", fake_fetch_all_layers), \
         patch.object(jobs_mod.gp_new, "fetch_pois_with_fallback", fake_pois_with_fallback), \
         patch.object(jobs_mod.gp_agg, "compute_count", fake_aggregate), \
         patch.object(jobs_mod, "fetch_area_geometries", fake_area), \
         patch.object(jobs_mod, "fetch_line_geometries", fake_line), \
         patch.object(jobs_mod, "fetch_named_features", fake_named), \
         patch.object(jobs_mod, "fetch_isochrones", fake_iso), \
         patch.object(jobs_mod, "geocode", fake_geocode), \
         patch.object(jobs_mod, "evaluate_route_constraint", fake_route_eval), \
         patch.object(jobs_mod, "fetch_railway_lines", fake_rail), \
         patch.object(jobs_mod, "reverse_geocode_name", fake_rgeo), \
         patch.object(jobs_mod, "critique_analysis", fake_critique), \
         patch.object(results_mod, "write_explanations", fake_explain):
        t0 = time.monotonic()
        asyncio.run(jobs_mod._run_analysis(job, spec))
        elapsed = time.monotonic() - t0
    return job, calls, elapsed


def test_water_and_buildability_fetches_run_concurrently_not_sequentially():
    """The exact regression this change is meant to prevent: water_geometry
    and buildability both fire for "high-end gym in Mumbai" (confirmed by the
    plan-level test above). With every Overpass call delayed by `delay_s`:

    - buildability alone makes 6 calls (railway area+line, ghat, protected,
      maidan, road_frontage) bounded by concurrency=2 -> ceil(6/2)=3 batches.
    - water makes 1 separate call.

    If sequential (the bug this test guards against): total >= water + 3
    buildability batches = 4 * delay_s. If concurrent (the fix): total is
    bounded by max(water, buildability) = 3 * delay_s. The threshold below
    sits strictly between the two, so a regression to sequential fetching
    fails this test.
    """
    delay_s = 0.2
    spec = _spec_for("high-end gym", "Mumbai")
    job, calls, elapsed = _run_pipeline_with_fetch_delay(spec, delay_s)
    assert job.status == "done", f"job failed: {job.error}"
    # Sanity: this really did exercise both water (>=1 area call beyond
    # buildability's own 2 area calls) and buildability (line + named calls).
    assert calls["area"] >= 3   # water + railway_area + protected_area
    assert calls["line"] >= 2   # railway_lines + road_frontage
    assert calls["named"] >= 2  # ghat + maidan
    sequential_bound = 4 * delay_s
    concurrent_bound = 3 * delay_s
    threshold = (sequential_bound + concurrent_bound) / 2
    assert elapsed < threshold, (
        f"elapsed={elapsed:.2f}s is not below the concurrent/sequential "
        f"midpoint ({threshold:.2f}s) — water and buildability fetches may "
        "have regressed to running sequentially again."
    )
