"""v1.4.9 — PlannerLite relevance-gate tests.

Pins the YAGNI planner behavior:
  - cafe plan skips buildability/water (and the pipeline makes ZERO Overpass
    geometry/named calls for them) yet still returns candidates;
  - riverside plan requires water/corridor;
  - supermarket plan marks rent/footprint unverified and skips buildability;
  - dark kitchen plan requires routing and skips buildability/water/frontage;
  - skipped stages never produce FAILED; degraded optional stages produce
    SUCCESS + provisional when candidates exist;
  - unsupported constraints are labeled, never scored;
  - analysisCompleteness ships in the success payload;
  - unverifiable critical constraints suppress the green RECOMMENDED badge.

All providers are mocked — no network.
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

from shapely.geometry import Polygon as ShapelyPolygon

from app.engine.planner_lite import create_analysis_plan
from app.models.spec import SpecV2
from app.providers.base import ProviderResult
from app.services import jobs as jobs_mod
from app.services.jobs import RESULT_STATES


# ── Spec builders (mirror the four live prompts) ──────────────────────────────

def _base_spec(objective: str, business: str, *, layers=None, waterfront=None,
               corridors=None, route_constraints=None) -> SpecV2:
    return SpecV2.model_validate({
        "version": "2.2",
        "objective": objective,
        "businessType": business,
        "studyArea": {"type": "places", "places": ["Pune"]},
        "layers": layers or [
            {"id": "demand", "name": "Demand proxy", "weight": 0.6,
             "direction": "positive",
             "source": {"provider": "osm", "tags": ["amenity=school"]},
             "catchment": {"type": "walk", "minutes": 10},
             "normalization": {"method": "minmax"}, "confidence": "medium",
             "proxyWarning": "POI count proxy."},
            {"id": "competition", "name": "Competition", "weight": 0.4,
             "direction": "negative",
             "source": {"provider": "google_places", "types": ["cafe"]},
             "catchment": {"type": "walk", "minutes": 8},
             "normalization": {"method": "minmax"}, "confidence": "high"},
        ],
        "exclusions": [], "corridors": corridors or [],
        "routeConstraints": route_constraints or [],
        "waterfront": waterfront,
        "output": {"topN": 3, "minCandidateSeparationHexRings": 1},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": False, "refineTopK": 6},
        "plan": {"businessArchetype": "generic", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    })


def _cafe_spec() -> SpecV2:
    return _base_spec(
        "Find the top 3 locations for a quick-service cafe targeting students "
        "near the Ruby crossing and the EM Bypass",
        "quick-service cafe",
    )


def _riverside_spec() -> SpecV2:
    return _base_spec(
        "Identify the 3 best sites for a premium riverside restaurant along the "
        "Hooghly River between Howrah Bridge and Vidyasagar Setu",
        "premium riverside restaurant",
        waterfront={"isWaterfront": True, "strictness": "strict",
                    "corridorWidthM": 500, "corridorSource": "llm"},
        corridors=[{
            "name": "riverfront_band",
            "source": {"provider": "osm", "tags": ["waterway=river"]},
            "maxDistanceM": 500, "mode": "include",
        }],
    )


def _supermarket_spec() -> SpecV2:
    return _base_spec(
        "Show me the 3 best locations for a massive 10,000 sq ft discount "
        "supermarket in Sector V. It must be on a primary arterial road but "
        "rent cannot exceed ₹20/sq ft",
        "discount supermarket",
    )


def _dark_kitchen_spec() -> SpecV2:
    return _base_spec(
        "I need a dark kitchen location in South Pune exactly within a "
        "10-minute delivery drive of Ballygunge Phari, strictly outside a 1km "
        "walking radius of any metro station",
        "dark kitchen",
        route_constraints=[{
            "name": "drive_to_phari", "mode": "drive", "maxMinutes": 10,
            "targetKeyword": "Ballygunge Phari", "required": True,
        }],
    )


# ── 1-4. Plan-level rules for the four live prompts ───────────────────────────

def test_cafe_plan_skips_water_but_requires_buildability():
    # v1.6.2 — "quick-service cafe" is a _COMMERCIAL_RE match: a cafe cannot
    # legally sit on rail land / a ghat / protected open space, so buildability
    # (and its frontage_proxy companion) is now correctly REQUIRED regardless
    # of city. Water stays skipped: no water/coastal-metro signal for "Pune".
    plan = create_analysis_plan(_cafe_spec())
    skipped = {s.stage for s in plan.skipped_stages}
    assert "water_geometry" in skipped
    assert "buildability" not in skipped
    assert plan.should_run("buildability")
    assert plan.should_run("frontage_proxy")
    assert "routing" in skipped                  # no drive/walk-time constraint stated
    assert plan.should_run("places_aggregate")   # competition needs POI counts
    assert plan.should_run("pass_a_scoring")
    assert plan.unsupported_constraints == []
    # student demand stays a labeled proxy
    assert plan.factor_support["demand"]["support"] == "proxy"


def test_riverside_plan_requires_water_and_keeps_buildability():
    plan = create_analysis_plan(_riverside_spec())
    assert plan.should_run("water_geometry")
    assert "water_geometry" in plan.required_stages
    assert plan.should_run("buildability")       # ghat/heritage genuinely relevant
    assert not plan.is_skipped("water_geometry")


def test_supermarket_plan_marks_rent_footprint_unverified_and_runs_buildability():
    # v1.6.2 — "supermarket" is a _COMMERCIAL_RE match, so buildability is now
    # correctly required (a supermarket cannot sit on rail/ghat/protected land).
    plan = create_analysis_plan(_supermarket_spec())
    keys = {c.constraint for c in plan.unsupported_constraints}
    assert "rent_or_lease_price" in keys
    assert "floor_area_footprint" in keys
    assert plan.should_run("buildability")
    assert plan.is_skipped("water_geometry")
    # unsupported constraints are labeled, never scored
    for c in plan.unsupported_constraints:
        assert c.should_score is False
        assert "not scored" in c.display_label
    # and none of them appears as a scoring factor
    assert set(plan.factor_support) == {"demand", "competition"}


def test_dark_kitchen_plan_requires_routing_skips_buildability_water_frontage():
    plan = create_analysis_plan(_dark_kitchen_spec())
    assert plan.should_run("routing")
    assert "routing" in plan.required_stages
    assert plan.is_skipped("water_geometry")
    assert plan.is_skipped("buildability")
    assert plan.is_skipped("frontage_proxy")


def test_plan_preview_shape_for_spec_card():
    prev = create_analysis_plan(_supermarket_spec()).to_preview_dict()
    assert prev["willVerify"]                     # core scoring at minimum
    assert any("Rent / lease price" in c for c in prev["cannotVerify"])
    assert all({"stage", "reason"} <= set(s) for s in prev["skipped"])


def test_plan_budgets_reflect_skips():
    # v1.6.2 — cafe now also runs buildability (correctly), so it plans MORE
    # overpass calls than before but still fewer than riverside (which adds
    # both the water fetch AND a corridor fetch on top of buildability).
    cafe = create_analysis_plan(_cafe_spec())
    river = create_analysis_plan(_riverside_spec())
    assert cafe.provider_budgets["overpassCallsPlanned"] < river.provider_budgets["overpassCallsPlanned"]
    # Dark kitchen (South Pune) genuinely skips both water and buildability —
    # the clearest "skips everything gated" baseline for the runtime-target check.
    dark = create_analysis_plan(_dark_kitchen_spec())
    assert dark.provider_budgets["overpassCallsPlanned"] < river.provider_budgets["overpassCallsPlanned"]
    assert dark.max_runtime_target_seconds <= river.max_runtime_target_seconds


# ── E2E harness (mirrors test_v147; all providers mocked, with call spies) ────

def _study_polygon() -> ShapelyPolygon:
    return ShapelyPolygon([
        (88.395, 22.505), (88.415, 22.505), (88.415, 22.525), (88.395, 22.525),
    ])


def _run_pipeline(spec: SpecV2, *, healthy_places: bool = True):
    """Run _run_analysis fully mocked. Returns (job, spies) where spies counts
    calls into the expensive Overpass geometry/named fetchers."""
    from app.engine import results as results_mod

    job = jobs_mod.Job(id="49914991-4991-4991-8991-499149914991")
    spies = {"area": 0, "line": 0, "named": 0, "water_tags_seen": []}

    async def fake_resolve_study_area(area):
        return _study_polygon(), []

    async def fake_fetch_all_layers(tag_sets, bbox):
        return {lid: [{"lat": 22.508 + i * 0.001, "lng": 88.40, "tags": {"name": f"o{i}"}}
                      for i in range(10)] for lid in tag_sets}

    async def fake_pois_with_fallback(types, keyword, bbox, *, legacy_fetch, ctx=None):
        if healthy_places:
            return ([{"lat": 22.51 + i * 0.001, "lng": 88.402,
                      "tags": {"name": f"g{i}", "google_type": "cafe"}}
                     for i in range(8)], "google_places_new_nearby", [])
        return [], "none", ["all Places providers failed (test)"]

    async def fake_aggregate(center, radius_m, included_types, *, ctx=None):
        return ProviderResult(provider="gaggregate", feature="insight_count",
                              status="disabled", data={},
                              degradation_reason="api_not_available_http_403")

    async def fake_area(tags, bbox):
        spies["area"] += 1
        spies["water_tags_seen"].extend(tags)
        return []

    async def fake_line(tags, bbox):
        spies["line"] += 1
        if any("water" in t or "river" in t for t in tags):
            return [{"geometry": [{"lat": 22.515, "lng": 88.394},
                                  {"lat": 22.515, "lng": 88.416}]}]
        return []

    async def fake_named(regex, bbox):
        spies["named"] += 1
        return []

    async def fake_iso(cells, mode, minutes):
        return {}

    async def fake_geocode(q):
        return (22.515, 88.405)

    async def fake_route_eval(rc, cells, targets, railway):
        return {i: {"status": "evaluated", "passed": True, "reason": "ok",
                    "networkM": 3000.0, "travelMin": 8.0, "crossesRailway": False,
                    "straightLineM": 2500.0, "target": targets[0] if targets else None}
                for i in range(len(cells))}

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
        asyncio.run(jobs_mod._run_analysis(job, spec))
    return job, spies


# ── 5/8/10. Cafe e2e: water genuinely skipped, buildability genuinely runs ────

def test_cafe_pipeline_skips_water_but_runs_buildability():
    job, spies = _run_pipeline(_cafe_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] == "success"
    assert r["locations"], "candidates must still be returned"
    # v1.7.2 CONTRACT CHANGE — the always-on BASELINE land-cover mask now
    # fetches natural=water (among forest/wetland/military) for EVERY run,
    # because physical unbuildability doesn't depend on prompt wording
    # (lake-dotted South Bengaluru was scoring cells in lakes). The heavy
    # water-CORRIDOR stage (waterway line geometry, riverbank logic) remains
    # planner-gated: no waterway/riverbank tags may be fetched here.
    assert not any(
        t.startswith(("waterway",)) for t in spies["water_tags_seen"]
    ), "the gated water-corridor stage must not run for a cafe brief"
    assert any(
        t == "natural=water" for t in spies["water_tags_seen"]
    ), "the baseline land-cover mask must always fetch water polygons"
    assert spies["area"] > 0 or spies["named"] > 0
    ac = r["analysisCompleteness"]
    skipped = {s["stage"] for s in ac["skippedStages"]}
    assert "water_geometry" in skipped
    assert "buildability" not in skipped
    # Skipped-irrelevant ≠ failure and does not punish confidence.
    assert ac["provisional"] is False
    assert ac["confidenceLevel"] == "H"
    assert ac["coreScoringComplete"] is True
    # buildabilityStatus is honest — genuinely checked now, never "unchecked".
    for loc in r["locations"]:
        assert loc.get("buildabilityStatus") in ("viable", "weak", "excluded")


# ── Riverside e2e: water/corridor genuinely runs ──────────────────────────────

def test_riverside_pipeline_runs_water_geometry():
    job, spies = _run_pipeline(_riverside_spec())
    assert job.status == "done", f"job failed: {job.error}"
    assert job.result["status"] in RESULT_STATES
    # Water geometry fetch DID run for the waterfront brief.
    assert spies["area"] >= 1
    assert any("water" in t or "river" in t for t in spies["water_tags_seen"])
    ac = job.result.get("analysisCompleteness")
    if ac:   # main payload path (no_viable_site early-return has no completeness)
        assert not any(s["stage"] == "water_geometry" for s in ac["skippedStages"])


# ── 6. Degraded optional stage → SUCCESS + provisional (never FAILED) ─────────

def test_degraded_places_still_success_but_provisional():
    job, _ = _run_pipeline(_cafe_spec(), healthy_places=False)
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] == "success"          # OSM factor still produced candidates
    assert r["locations"]
    ac = r["analysisCompleteness"]
    assert ac["provisional"] is True         # relevant stage degraded
    assert ac["confidenceLevel"] in ("M", "L")
    assert ac["placesVerified"] is False
    assert any("places" in d for d in ac["degradedStages"])


# ── 7/9. Supermarket e2e: unsupported constraints visible, never RECOMMENDED ──

def test_supermarket_unsupported_constraints_suppress_recommended():
    job, spies = _run_pipeline(_supermarket_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] == "success"
    ac = r["analysisCompleteness"]
    labels = " ".join(c["displayLabel"] for c in ac["unsupportedConstraints"])
    assert "Rent / lease price" in labels
    assert "Floor area / footprint" in labels
    assert all(c["shouldScore"] is False for c in ac["unsupportedConstraints"])
    assert ac["provisional"] is True
    # Green RECOMMENDED suppressed while critical constraints are unverifiable.
    assert all(
        loc.get("recommendationStatus") != "RECOMMENDED"
        for loc in r["locations"]
    )
    # v1.6.2 — buildability now correctly RUNS for a supermarket brief
    # (_COMMERCIAL_RE match), so its area/named calls DO fire.
    assert spies["area"] > 0 or spies["named"] > 0


# ── Dark kitchen e2e: routing runs, buildability/water skipped ────────────────

def test_dark_kitchen_pipeline_routes_and_skips_buildability():
    job, spies = _run_pipeline(_dark_kitchen_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] in RESULT_STATES
    # v1.7.2 — exactly one area fetch is the always-on baseline land-cover
    # mask; buildability's own area/named fetches remain correctly skipped.
    assert spies["area"] == 1 and spies["named"] == 0
    ac = r.get("analysisCompleteness")
    assert ac is not None
    assert ac["routeVerified"] is True                  # routing genuinely evaluated
    skipped = {s["stage"] for s in ac["skippedStages"]}
    assert {"water_geometry", "buildability"} <= skipped
    # Route metrics attached — drive-time verified, never a silent Euclidean pass.
    routed = [loc for loc in r["locations"] if loc.get("routeMetrics")]
    assert routed, "route metrics must be attached to ranked candidates"
