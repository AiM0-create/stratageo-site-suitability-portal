"""v1.4.8 — Google Places (New) / Aggregate / Routes provider-layer tests.

All network calls are mocked. Covers the required matrix:
  legacy kept as fallback · Aggregate→FactorValue · evidence-only POIs ·
  Text Search for ambiguous intent · Details cap · Search Along Route
  polyline · route-unavailable → provisional · photos/AI-summaries never in
  scoring/masks unless flagged · explicit field masks (never `*`) · timeout
  degradation · bounded 429/5xx retry with backoff · permanent failure never
  kills the job · lists never reach numeric scoring · payload stays
  SUCCESS/NO_VIABLE_SITE/FAILED · providerDiagnostics shape.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from shapely.geometry import Polygon as ShapelyPolygon

from app.engine import contracts
from app.providers import base as pbase
from app.providers import google_place_enrichment as gp_details
from app.providers import google_places_aggregate as gp_agg
from app.providers import google_places_new as gp_new
from app.providers import google_routes as gr
from app.providers.base import ProviderBudget, ProviderContext, ProviderResult, run_provider
from app.services import jobs as jobs_mod
from app.services.jobs import ProviderBreaker, RESULT_STATES


def _stub_settings(**over):
    base = dict(
        google_places_api_key="test-key-not-real", ors_api_key="",
        enable_google_places_new=True, enable_google_places_aggregate=True,
        enable_google_place_details_new=True, enable_google_place_photos=False,
        enable_google_ai_summaries=False, enable_google_routes_validation=True,
        enable_google_search_along_route=False,
        google_places_timeout_seconds=5.0, google_places_max_retries=2,
        google_places_total_budget_seconds_per_job=45.0,
        google_places_aggregate_timeout_seconds=5.0,
        google_routes_timeout_seconds=5.0,
        google_details_max_places_per_job=6, google_photos_max_places_per_job=3,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _http_error(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "https://example.invalid/x")
    return httpx.HTTPStatusError(
        f"HTTP {code}", request=req, response=httpx.Response(code, request=req),
    )


BBOX = (22.505, 88.395, 22.525, 88.415)


# ── 10. Field masks are explicit, minimal, never wildcard ─────────────────────

def test_field_masks_are_explicit_and_never_wildcard():
    from app.engine.traffic import FIELD_MASK as TRAFFIC_MASK
    masks = [
        gp_new.SEARCH_FIELD_MASK,
        gp_details.DETAILS_FIELD_MASK_BASE,
        gr.ROUTES_FIELD_MASK,
        TRAFFIC_MASK,
    ]
    for m in masks:
        assert "*" not in m, f"wildcard field mask found: {m}"
        assert len(m.split(",")) >= 3   # genuinely enumerated, not a stub

    # Search mask carries exactly the minimal evidence fields
    for f in ("places.id", "places.displayName", "places.location",
              "places.primaryType", "places.rating", "places.priceLevel"):
        assert f in gp_new.SEARCH_FIELD_MASK


# ── 8/9. Photos + AI summaries only behind flags, never in scoring ────────────

def test_photos_and_summaries_excluded_from_details_mask_by_default():
    with patch.object(gp_details, "get_settings", lambda: _stub_settings()):
        mask = gp_details.details_field_mask()
    assert "photos" not in mask
    assert "generativeSummary" not in mask and "reviewSummary" not in mask


def test_photos_and_summaries_appended_only_when_flagged():
    with patch.object(gp_details, "get_settings", lambda: _stub_settings(
            enable_google_place_photos=True, enable_google_ai_summaries=True)):
        mask = gp_details.details_field_mask()
    assert "photos" in mask
    assert "generativeSummary" in mask
    assert "*" not in mask


# ── run_provider policy: timeout / retry / breaker / budget ───────────────────

def test_run_provider_timeout_degrades_no_retry():
    calls = {"n": 0}

    async def slow():
        calls["n"] += 1
        await asyncio.sleep(5)
        return {}

    pr = asyncio.run(run_provider(
        slow, provider="placesnew", feature="t", timeout=0.05, max_retries=3,
    ))
    assert pr.status == "timeout"
    assert calls["n"] == 1                # timeouts are never retried
    assert pr.degradation_reason.startswith("timeout_")


def test_run_provider_retries_429_with_bounded_backoff():
    calls = {"n": 0}
    delays: list[float] = []

    async def flaky():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise _http_error(429)
        return {"count": 7}

    async def fake_sleep(d):
        delays.append(d)

    with patch.object(pbase.asyncio, "sleep", fake_sleep):
        pr = asyncio.run(run_provider(
            flaky, provider="gaggregate", feature="t", timeout=5, max_retries=2,
        ))
    assert pr.status == "ok" and pr.data == {"count": 7}
    assert calls["n"] == 3
    assert len(delays) == 2 and delays[1] > delays[0]    # exponential backoff


def test_run_provider_5xx_exhausts_retries_then_fails_not_raises():
    async def broken():
        raise _http_error(503)

    async def fake_sleep(d):
        pass

    with patch.object(pbase.asyncio, "sleep", fake_sleep):
        pr = asyncio.run(run_provider(
            broken, provider="placesnew", feature="t", timeout=5, max_retries=2,
        ))
    assert pr.status == "failed"
    assert pr.diagnostics["attempts"] == 3
    assert pr.degradation_reason == "http_503"


def test_run_provider_403_means_disabled_no_retry():
    calls = {"n": 0}

    async def forbidden():
        calls["n"] += 1
        raise _http_error(403)

    pr = asyncio.run(run_provider(
        forbidden, provider="gaggregate", feature="t", timeout=5, max_retries=3,
    ))
    assert pr.status == "disabled"
    assert calls["n"] == 1


def test_run_provider_circuit_breaker_short_circuits():
    breaker = ProviderBreaker(threshold=2)
    ctx = ProviderContext(breaker=breaker)
    calls = {"n": 0}

    async def broken():
        calls["n"] += 1
        raise _http_error(500)

    async def fake_sleep(d):
        pass

    async def run_all():
        for _ in range(4):
            await run_provider(broken, provider="placesnew", feature="t",
                               timeout=5, max_retries=0, ctx=ctx)

    with patch.object(pbase.asyncio, "sleep", fake_sleep):
        asyncio.run(run_all())
    assert calls["n"] == 2                       # circuit opened after 2 failures
    assert ctx.call_log[-1]["degradationReason"] == "circuit_open"


def test_run_provider_budget_exhaustion_degrades():
    ctx = ProviderContext(budget=ProviderBudget(0.0))   # already exhausted

    async def fine():
        return {"x": 1}

    pr = asyncio.run(run_provider(fine, provider="placesnew", feature="t",
                                  timeout=5, ctx=ctx))
    assert pr.status == "degraded"
    assert pr.degradation_reason == "google_budget_exhausted"


def test_run_provider_per_job_cache_hits():
    ctx = ProviderContext()
    calls = {"n": 0}

    async def fine():
        calls["n"] += 1
        return {"pois": [1]}

    async def run_twice():
        a = await run_provider(fine, provider="placesnew", feature="t",
                               timeout=5, ctx=ctx, cache_key="k1")
        b = await run_provider(fine, provider="placesnew", feature="t",
                               timeout=5, ctx=ctx, cache_key="k1")
        return a, b

    a, b = asyncio.run(run_twice())
    assert calls["n"] == 1
    assert b.diagnostics.get("cacheHit") is True
    assert b.data == a.data


# ── 1/11/13. Priority chain: New primary, legacy fallback, never raises ───────

def _pr(status, pois=None, reason=None):
    return ProviderResult(provider="placesnew", feature="nearby_search",
                          status=status, data={"pois": pois or []},
                          degradation_reason=reason)


def test_legacy_places_kept_as_fallback_when_new_fails():
    async def new_fails(types, center, radius_m, *, ctx=None):
        return _pr("failed", reason="http_500")

    async def legacy(types, keyword, bbox):
        return [{"lat": 22.51, "lng": 88.40, "tags": {"name": "L1", "google_type": "cafe"}}]

    with patch.object(gp_new, "get_settings", lambda: _stub_settings()), \
         patch.object(gp_new, "search_nearby", new_fails):
        pois, src, notes = asyncio.run(gp_new.fetch_pois_with_fallback(
            ["cafe"], None, BBOX, legacy_fetch=legacy,
        ))
    assert src == "google_places_legacy"
    assert len(pois) == 1
    assert any("falling back to legacy" in n for n in notes)


def test_new_places_used_as_primary_when_healthy():
    async def new_ok(types, center, radius_m, *, ctx=None):
        return _pr("ok", pois=[{
            "lat": 22.51, "lng": 88.40, "placeId": "pid1",
            "tags": {"name": "N1", "google_type": "cafe"},
            "rating": 4.4, "userRatingCount": 120, "priceLevel": "PRICE_LEVEL_MODERATE",
            "source": "google_places_new",
        }])

    async def legacy(types, keyword, bbox):
        raise AssertionError("legacy must not be called when New succeeds")

    with patch.object(gp_new, "get_settings", lambda: _stub_settings()), \
         patch.object(gp_new, "search_nearby", new_ok):
        pois, src, notes = asyncio.run(gp_new.fetch_pois_with_fallback(
            ["cafe"], None, BBOX, legacy_fetch=legacy,
        ))
    assert src == "google_places_new_nearby"
    assert pois and pois[0]["placeId"] == "pid1"


def test_timeout_on_new_falls_back_to_legacy():
    async def new_timeout(types, center, radius_m, *, ctx=None):
        return _pr("timeout", reason="timeout_12s")

    async def legacy(types, keyword, bbox):
        return [{"lat": 22.5, "lng": 88.4, "tags": {"name": "L", "google_type": "cafe"}}]

    with patch.object(gp_new, "get_settings", lambda: _stub_settings()), \
         patch.object(gp_new, "search_nearby", new_timeout):
        pois, src, _ = asyncio.run(gp_new.fetch_pois_with_fallback(
            ["cafe"], None, BBOX, legacy_fetch=legacy,
        ))
    assert src == "google_places_legacy" and len(pois) == 1


def test_total_provider_failure_returns_empty_never_raises():
    async def new_fails(types, center, radius_m, *, ctx=None):
        return _pr("failed", reason="http_500")

    async def legacy_fails(types, keyword, bbox):
        raise RuntimeError("legacy dead too")

    with patch.object(gp_new, "get_settings", lambda: _stub_settings()), \
         patch.object(gp_new, "search_nearby", new_fails):
        pois, src, notes = asyncio.run(gp_new.fetch_pois_with_fallback(
            ["cafe"], None, BBOX, legacy_fetch=legacy_fails,
        ))
    assert pois == [] and src == "none"
    assert any("OSM supplement" in n or "legacy" in n.lower() for n in notes)


# ── 4. Text Search (New) for keyworded / ambiguous business intent ────────────

def test_text_search_used_for_keyword_queries():
    captured: dict = {}

    async def fake_post(url, body, timeout):
        captured["url"] = url
        captured["body"] = body
        return {"places": [{
            "id": "pid-prem", "displayName": {"text": "Premium Diner"},
            "location": {"latitude": 22.51, "longitude": 88.41},
            "primaryType": "restaurant", "rating": 4.7, "userRatingCount": 900,
        }]}

    with patch.object(gp_new, "get_settings", lambda: _stub_settings()), \
         patch.object(gp_new, "_post", fake_post):
        pois, src, _ = asyncio.run(gp_new.fetch_pois_with_fallback(
            ["restaurant"], "premium riverside restaurant", BBOX,
            legacy_fetch=None,
        ))
    assert src == "google_places_new_text"
    assert captured["url"] == gp_new.TEXT_URL
    assert captured["body"]["textQuery"] == "premium riverside restaurant"
    assert "locationBias" in captured["body"]
    assert pois[0]["placeId"] == "pid-prem"
    # 3/14: POIs are evidence dicts — feeding them into numeric scoring raises.
    with pytest.raises(contracts.ContractViolation):
        contracts.FactorValue(hex_id="h", raw_value=pois, normalized_score=0.5)
    # The sanctioned numeric path: an explicit count.
    count = contracts.aggregate_provider_values(
        [1] * len(pois), "count")
    fv = contracts.FactorValue(hex_id="h", raw_value=count,
                               normalized_score=contracts.normalize_0_1(count, 0, 10))
    assert fv.raw_value == 1.0


# ── 2. Places Aggregate count → validated FactorValue ─────────────────────────

def test_aggregate_count_maps_to_numeric_factor_value():
    async def fake_post_ok():
        return {"count": 42}

    async def call_provider():
        with patch.object(gp_agg, "get_settings", lambda: _stub_settings()):
            with patch.object(gp_agg.httpx, "AsyncClient") as MC:
                client = MC.return_value.__aenter__.return_value
                async def post(url, json=None, headers=None):
                    req = httpx.Request("POST", url)
                    return httpx.Response(200, json={"count": "42"}, request=req)
                client.post = post
                return await gp_agg.compute_count((22.51, 88.40), 800, ["cafe"])

    pr = asyncio.run(call_provider())
    assert pr.status == "ok"
    cnt = contracts.to_finite_float(pr.data["count"], None, label="agg")
    fv = contracts.FactorValue(
        hex_id="8f2a", raw_value=cnt,
        normalized_score=contracts.normalize_0_1(cnt, 0, 100),
        evidence_count=int(cnt),
    )
    assert fv.raw_value == 42.0
    assert 0.0 <= fv.normalized_score <= 1.0
    assert contracts.validate_factor_result(
        contracts.FactorResult(factor_id="cafes", values=[fv])) == []


# ── 5. Place Details capped to selected top evidence POIs ─────────────────────

def test_place_details_enrichment_respects_cap():
    calls = {"n": 0}

    async def fake_details(place_id, *, ctx=None):
        calls["n"] += 1
        return ProviderResult(
            provider="gdetails", feature="place_details", status="ok",
            data={"place": {"placeId": place_id, "name": f"P{place_id}",
                            "rating": 4.2, "userRatingCount": 10}},
        )

    pois = [{"placeId": f"pid{i}", "lat": 22.5, "lng": 88.4} for i in range(20)]
    with patch.object(gp_details, "fetch_place_details", fake_details):
        out = asyncio.run(gp_details.enrich_top_pois(pois, cap=5))
    assert len(out) == 5
    assert calls["n"] == 5                       # never every raw result


def test_place_details_stops_when_api_disabled():
    calls = {"n": 0}

    async def fake_details(place_id, *, ctx=None):
        calls["n"] += 1
        return ProviderResult(provider="gdetails", feature="place_details",
                              status="disabled", data={},
                              degradation_reason="api_not_available_http_403")

    pois = [{"placeId": f"pid{i}"} for i in range(10)]
    with patch.object(gp_details, "fetch_place_details", fake_details):
        out = asyncio.run(gp_details.enrich_top_pois(pois, cap=6))
    assert out == [] and calls["n"] == 1


# ── 6. Search Along Route uses the route polyline ─────────────────────────────

def test_search_along_route_sends_encoded_polyline():
    captured: dict = {}

    async def fake_post(url, body, timeout):
        captured["body"] = body
        return {"places": []}

    with patch.object(gp_new, "get_settings", lambda: _stub_settings()), \
         patch.object(gp_new, "_post", fake_post):
        pr = asyncio.run(gp_new.search_along_route("ev charging", "abc123XYZ"))
    assert pr.ok
    assert captured["body"]["searchAlongRouteParameters"]["polyline"]["encodedPolyline"] == "abc123XYZ"


def test_polyline_decoder_roundtrip_known_vector():
    # Google's documented example: "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    coords = gr.decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    # → (lat,lng): (38.5,-120.2) (40.7,-120.95) (43.252,-126.453); ours is (lng,lat)
    assert coords[0] == pytest.approx((-120.2, 38.5))
    assert coords[2] == pytest.approx((-126.453, 43.252))


# ── 7. Route unavailable → provisional, never Euclidean ───────────────────────

def test_route_google_fails_and_no_ors_returns_none():
    from app.engine import routing as routing_mod

    async def google_dead(origin, dest, mode, *, ctx=None):
        return ProviderResult(provider="groutes", feature="compute_route",
                              status="failed", data={}, degradation_reason="http_500")

    with patch.object(routing_mod, "get_settings", lambda: _stub_settings()), \
         patch("app.providers.google_routes.compute_route", google_dead):
        r = asyncio.run(routing_mod.route((22.5, 88.4), (22.52, 88.41), "drive"))
    assert r is None            # caller marks constraint unavailable/provisional


def test_evaluate_route_constraint_marks_unavailable_when_no_route():
    from app.engine import routing as routing_mod
    from app.engine.grid import HexCell

    async def no_route(origin, dest, mode, avoid_geojson=None, cache_tag=""):
        return None

    constraint = SimpleNamespace(mode="drive", maxMinutes=10, maxDistanceM=None,
                                 avoidRailwayCrossing=False)
    cells = [HexCell(h3_id="a", lat=22.5, lng=88.4)]
    with patch.object(routing_mod, "route", no_route):
        out = asyncio.run(routing_mod.evaluate_route_constraint(
            constraint, cells, [(22.52, 88.41)], [],
        ))
    assert out[0]["status"] == "unavailable"
    assert out[0]["passed"] is None      # NOT silently passed on Euclidean


def test_route_result_carries_provider_label():
    from app.engine import routing as routing_mod

    async def google_ok(origin, dest, mode, *, ctx=None):
        return ProviderResult(
            provider="groutes", feature="compute_route", status="ok",
            data={"distanceM": 4200.0, "durationMin": 8.4,
                  "geomCoords": [(88.4, 22.5), (88.41, 22.52)],
                  "encodedPolyline": "xx"},
        )

    with patch.object(routing_mod, "get_settings", lambda: _stub_settings()), \
         patch("app.providers.google_routes.compute_route", google_ok):
        r = asyncio.run(routing_mod.route((22.5, 88.4), (22.52, 88.41), "drive"))
    assert r["provider"] == "google_routes"
    assert r["durationMin"] == 8.4


# ── 15/16. Product correctness stays intact with Google data present ──────────

def test_supermarket_rent_footprint_still_unverified_with_google_providers():
    from app.engine.constraint_policy import evaluate_constraint_policy
    from app.models.spec import SpecV2
    spec = SpecV2.model_validate({
        "version": "2.2",
        "objective": "10,000 sq ft discount supermarket in Sector V, rent under ₹20/sq ft",
        "businessType": "discount supermarket",
        "studyArea": {"type": "places", "places": ["Sector V, Kolkata"]},
        "layers": [{
            "id": "l1", "name": "Competing supermarket density", "weight": 1.0,
            "direction": "negative",
            "source": {"provider": "google_places", "types": ["supermarket"]},
            "catchment": {"type": "drive", "minutes": 10},
            "normalization": {"method": "minmax"}, "confidence": "medium",
        }],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3}, "grid": {"resolution": 8},
        "execution": {}, "plan": {"businessArchetype": "large_format_retail"},
        "meta": {"unsupportedRequests": []},
    })
    policy = evaluate_constraint_policy(spec=spec, locations=[])
    joined = " ".join(policy.unverifiedHardConstraints).lower()
    assert "rent" in joined and ("floor area" in joined or "footprint" in joined)


def test_dark_kitchen_strict_route_still_guarded():
    from app.engine.route_policy import validate_strict_route_constraints
    from app.models.spec import SpecV2
    spec = SpecV2.model_validate({
        "version": "2.2",
        "objective": "Dark kitchen exactly within a 10-minute delivery drive of Ballygunge Phari",
        "businessType": "dark kitchen",
        "studyArea": {"type": "places", "places": ["South Kolkata"]},
        "layers": [{
            "id": "demand", "name": "Residential delivery demand", "weight": 1.0,
            "direction": "positive",
            "source": {"provider": "osm", "tags": ["building=residential"]},
            "catchment": {"type": "drive", "minutes": 12},
            "normalization": {"method": "minmax"}, "confidence": "medium",
        }],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3}, "grid": {"resolution": 9},
        "execution": {}, "plan": {"businessArchetype": "dark_kitchen"},
        "meta": {"unsupportedRequests": []},
    })
    check = validate_strict_route_constraints(
        spec=spec,
        raw_intent_dict={"rawPrompt": spec.objective,
                         "hardConstraintPhrases": ["exactly within a 10-minute delivery drive"],
                         "hasStrictRouteConstraint": True},
        has_ors=False, has_google_routes=False,
    )
    assert not check.ok


# ── 17/18. End-to-end with healthy Google providers: contract + diagnostics ───

def _study_polygon() -> ShapelyPolygon:
    return ShapelyPolygon([
        (88.395, 22.505), (88.415, 22.505), (88.415, 22.525), (88.395, 22.525),
    ])


def _google_pois(n: int) -> list[dict]:
    return [{
        "lat": 22.508 + (i % 5) * 0.002, "lng": 88.398 + (i // 5) * 0.002,
        "tags": {"name": f"G{i}", "google_type": "cafe"},
        "placeId": f"pid{i}", "rating": 4.0 + (i % 10) / 10,
        "userRatingCount": 50 + i, "source": "google_places_new",
    } for i in range(n)]


def test_pipeline_with_healthy_google_providers_full_contract():
    """Cafe pipeline with Places New + Aggregate + Details all healthy (mocked):
    payload stays in the three-state contract, Aggregate counts land in refined
    scoring as floats, Details enrich ≤ cap POIs, googleCalls diagnostics ship."""
    from app.engine import results as results_mod
    from app.models.spec import SpecV2

    spec = SpecV2.model_validate({
        "version": "2.2",
        "objective": "Find the top 3 locations for a quick-service cafe targeting students",
        "businessType": "quick-service cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata"]},
        "layers": [
            {"id": "students", "name": "Student catchment", "weight": 0.5,
             "direction": "positive",
             "source": {"provider": "osm", "tags": ["amenity=school"]},
             "catchment": {"type": "walk", "minutes": 10},
             "normalization": {"method": "minmax"}, "confidence": "medium"},
            {"id": "cafes", "name": "Direct cafe competition", "weight": 0.5,
             "direction": "negative",
             "source": {"provider": "google_places", "types": ["cafe"]},
             "catchment": {"type": "walk", "minutes": 8},
             "normalization": {"method": "minmax"}, "confidence": "high"},
        ],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3, "minCandidateSeparationHexRings": 1},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": False, "refineTopK": 6},
        "plan": {"businessArchetype": "qsr_cafe", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    })
    job = jobs_mod.Job(id="48814881-4881-4881-8881-488148814881")

    async def fake_resolve_study_area(area):
        return _study_polygon(), []

    async def fake_fetch_all_layers(tag_sets, bbox):
        return {lid: [{"lat": 22.51 + i * 0.001, "lng": 88.40, "tags": {"name": f"o{i}"}}
                      for i in range(10)] for lid in tag_sets}

    async def fake_pois_with_fallback(types, keyword, bbox, *, legacy_fetch, ctx=None):
        return _google_pois(15), "google_places_new_nearby", []

    async def fake_aggregate(center, radius_m, included_types, *, ctx=None):
        pr = ProviderResult(provider="gaggregate", feature="insight_count",
                            status="ok", data={"count": 42}, elapsed_ms=120)
        if ctx is not None:            # mirror run_provider's diagnostics recording
            ctx.record(pr)
        return pr

    async def fake_details(place_id, *, ctx=None):
        pr = ProviderResult(
            provider="gdetails", feature="place_details", status="ok",
            data={"place": {"placeId": place_id, "name": "X", "rating": 4.5,
                            "userRatingCount": 200, "priceLevel": "PRICE_LEVEL_MODERATE"}},
            elapsed_ms=80)
        if ctx is not None:
            ctx.record(pr)
        return pr

    async def fake_area(tags, bbox):
        return []

    async def fake_line(tags, bbox):
        return []

    async def fake_named(regex, bbox):
        return []

    async def fake_iso(cells, mode, minutes):
        return {}

    async def fake_rgeo(lat, lng):
        return "Test Zone"

    async def fake_critique(*a, **k):
        return None

    async def fake_explain(spec_, locations, ds=None):
        return "s", ["r"] * len(locations)

    _real = jobs_mod.get_settings()
    _s2 = _real.model_copy(update={
        "google_places_api_key": "test-key-not-real",
        "enable_google_places_aggregate": True,
        "enable_google_place_details_new": True,
        "google_details_max_places_per_job": 4,
    })

    with patch.object(jobs_mod, "get_settings", lambda: _s2), \
         patch.object(jobs_mod, "resolve_study_area", fake_resolve_study_area), \
         patch.object(jobs_mod, "fetch_all_layers", fake_fetch_all_layers), \
         patch.object(jobs_mod.gp_new, "fetch_pois_with_fallback", fake_pois_with_fallback), \
         patch.object(jobs_mod.gp_agg, "compute_count", fake_aggregate), \
         patch.object(jobs_mod.gp_details, "fetch_place_details", fake_details), \
         patch.object(jobs_mod, "fetch_area_geometries", fake_area), \
         patch.object(jobs_mod, "fetch_line_geometries", fake_line), \
         patch.object(jobs_mod, "fetch_named_features", fake_named), \
         patch.object(jobs_mod, "fetch_isochrones", fake_iso), \
         patch.object(jobs_mod, "reverse_geocode_name", fake_rgeo), \
         patch.object(jobs_mod, "critique_analysis", fake_critique), \
         patch.object(results_mod, "write_explanations", fake_explain):
        asyncio.run(jobs_mod._run_analysis(job, spec))

    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    # 17 — payload contract intact
    assert r["status"] in RESULT_STATES
    assert r["jobRef"] == job.id[:8]
    # 2/6 — Aggregate refined counts landed in factorScores as floats
    cafes_fs = next(fs for fs in r["factorScores"] if fs["factorId"] == "cafes")
    refined_vals = [v["rawValue"] for v in cafes_fs["values"] if v["rawValue"] is not None]
    assert 42.0 in refined_vals
    assert all(isinstance(v, float) for v in refined_vals)
    # evidence label carries the aggregate source
    assert any("Google Places Aggregate" in n
               for n in r["spec"]["parsingNotes"])
    # 5 — Details enrichment capped
    enriched = [p for loc in r["locations"] for p in loc.get("poiEvidence", [])]
    assert 0 < len(enriched) <= 4
    assert all("rating" in p for p in enriched)
    # 18 — providerDiagnostics shape
    diags = r["providerDiagnostics"]
    assert "googleCalls" in diags and diags["googleCalls"]
    for c in diags["googleCalls"]:
        for key in ("provider", "feature", "status", "elapsedMs"):
            assert key in c
    # Photos/summaries never present anywhere in scoring inputs
    for fs in r["factorScores"]:
        for v in fs["values"]:
            assert not isinstance(v["rawValue"], (list, dict))
