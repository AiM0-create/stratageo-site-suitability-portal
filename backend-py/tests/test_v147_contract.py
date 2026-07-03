"""v1.4.7 regression tests — numeric scoring contract + three-state results.

Root-cause regression: every cafe/riverside production run with a degraded
provider died at evidence assembly with
    TypeError: unsupported operand type(s) for +: 'int' and 'list'
because evidence_builder._build_excluded_mask summed ALL mask_stats values and
v1.4.2/v1.4.6 put LISTS (buildabilityDegraded / providerDegraded) into that
dict. These tests pin:

  1. mask_stats containing lists NEVER crashes the evidence trail, and the
     removed-hex arithmetic only sees whitelisted counters.
  2. The numeric contract helpers (to_finite_float / normalize_0_1 /
     aggregate_provider_values / FactorValue / validate_factor_result).
  3. _degradable_call: retry-with-backoff, no-retry-on-timeout, circuit breaker.
  4. Three-state result contract: every terminal payload is
     success / no_viable_site / failed; FAILED carries stage+errorCode+jobRef.
  5. End-to-end cafe and riverside pipelines with mocked (degrading) providers
     complete without int+list-style crashes.
  6. Supermarket rent/footprint marked unverified; dark kitchen never treats
     Euclidean as a confirmed drive-time.

All provider calls are mocked — no network.
"""
from __future__ import annotations

import asyncio
import math
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest
from shapely.geometry import Polygon as ShapelyPolygon

from app.engine import contracts
from app.engine.contracts import (
    ContractViolation,
    FactorResult,
    FactorValue,
    aggregate_provider_values,
    normalize_0_1,
    safe_int_sum,
    to_finite_float,
    validate_factor_result,
)
from app.engine.evidence_builder import (
    _build_excluded_mask,
    _removed_hex_count,
    assemble_evidence_trail,
    QueryTracker,
)
from app.services import jobs as jobs_mod
from app.services.jobs import (
    Job,
    JobCancelled,
    ProviderBreaker,
    RESULT_STATES,
    _degradable_call,
    _failed_result,
)


def _job() -> Job:
    return Job(id="47114711-4711-4711-8711-471147114711")


# ── 1. The exact production regression ────────────────────────────────────────

DEGRADED_MASK_STATS = {
    # int hex-removal counters (legitimate arithmetic inputs)
    "railwayRemoved": 12,
    "ghatRemoved": 3,
    "protectedOpenSpaceRemoved": 7,
    "maidanRemoved": 2,
    "corridorRemoved": 30,
    "waterOverlapRemoved": 5,
    # NON-removal ints that must NOT count as removed hexes
    "metroExclusionStationCount": 40,
    "metroExclusionOverrideApplied": 1,
    "metroExclusionUnenforced": 0,
    "viableCandidates": 2,
    "minViableScore": 5.0,
    # the v1.4.2/v1.4.6 LISTS that crashed production
    "buildabilityDegraded": ["ghat", "maidan"],
    "providerDegraded": ["places_backup_l1", "water_body_geometry"],
}


def test_removed_hex_count_ignores_lists_and_non_removal_keys():
    # 12+3+7+2+30+5 = 59; station count / flags / lists / floats excluded.
    assert _removed_hex_count(DEGRADED_MASK_STATS) == 59


def test_build_excluded_mask_with_degradation_lists_no_typeerror():
    mask = _build_excluded_mask(DEGRADED_MASK_STATS, 100)
    assert mask.dtype == bool
    assert int(mask.sum()) == 59
    assert int((~mask).sum()) == 41


def _minimal_spec_and_scores():
    from app.models.spec import SpecV2
    from app.engine.scoring import LayerScores

    spec = SpecV2.model_validate({
        "version": "2.2",
        "objective": "Find a quick-service cafe targeting students",
        "businessType": "qsr_cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata"]},
        "layers": [
            {
                "id": "student_catchment", "name": "Student Catchment",
                "weight": 0.6, "direction": "positive",
                "source": {"provider": "osm", "tags": ["amenity=school"]},
                "catchment": {"type": "walk", "minutes": 10},
                "normalization": {"method": "minmax"},
                "confidence": "medium",
            },
            {
                "id": "competition", "name": "Direct Competition",
                "weight": 0.4, "direction": "negative",
                "source": {"provider": "osm", "tags": ["amenity=cafe"]},
                "catchment": {"type": "walk", "minutes": 8},
                "normalization": {"method": "minmax"},
                "confidence": "medium",
            },
        ],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3, "minCandidateSeparationHexRings": 2},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": True, "refineTopK": 12},
        "plan": {"businessArchetype": "qsr_cafe", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    })
    scores = {
        "student_catchment": LayerScores(
            layer=spec.layers[0], raw=np.array([5.0, 3.0, 8.0]),
            norm_low=3.0, norm_high=8.0, has_data=True, proxy_radius_m=800.0),
        "competition": LayerScores(
            layer=spec.layers[1], raw=np.array([2.0, 4.0, 1.0]),
            norm_low=1.0, norm_high=4.0, has_data=True, proxy_radius_m=640.0),
    }
    return spec, scores


def test_assemble_evidence_trail_survives_degradation_lists():
    """v1.4.6 production crash regression: mask_stats carrying the degradation
    LISTS must flow through evidence assembly without a TypeError."""
    from unittest.mock import MagicMock
    from app.engine.grid import HexCell

    spec, scores = _minimal_spec_and_scores()
    polygon = MagicMock()
    polygon.bounds = (88.3, 22.5, 88.4, 22.6)
    polygon.simplify = MagicMock(return_value=polygon)
    polygon.wkt = "POLYGON ((88.3 22.5, 88.4 22.5, 88.4 22.6, 88.3 22.6, 88.3 22.5))"
    hexes = [HexCell(h3_id=f"8f2a10{i}000000", lat=22.5 + i * 0.01, lng=88.35)
             for i in range(3)]
    locations = [{"name": "Site A", "lat": 22.51, "lng": 88.36, "mcda_score": 7.2,
                  "excluded": False, "recommended": True,
                  "criteria_breakdown": [], "exclusions": []}]
    qt = QueryTracker()
    qt.record_osm("main_fetch", ["amenity=school"], (22.5, 88.3, 22.6, 88.4), 15)

    et = assemble_evidence_trail(
        job_id="cafe-regression-0000",
        spec=spec, polygon=polygon, hexes=hexes, scores=scores,
        layer_pois={"student_catchment": [], "competition": []},
        locations=locations, candidate_indices=[0],
        mask_stats=dict(DEGRADED_MASK_STATS, corridorRemoved=1),
        provider_queries=qt.records,
        h3_count_before=100,
        analysis_status="reliable", relaxation_options=[], limitations=[],
        created_at="2026-07-01T10:00:00Z",
    )
    assert et.jobId == "cafe-regression-0000"
    # 12+3+7+2+1+5 = 30 removed → 70 left; station count must NOT deflate it.
    assert et.studyArea.h3CellCountAfterMasks == 70


# ── 2. Numeric contract helpers ────────────────────────────────────────────────

class TestToFiniteFloat:
    def test_scalars(self):
        assert to_finite_float(3) == 3.0
        assert to_finite_float(3.5) == 3.5
        assert to_finite_float(True) == 1.0
        assert to_finite_float(np.float64(2.25)) == 2.25
        assert to_finite_float(np.int32(7)) == 7.0

    def test_none_nan_inf_go_to_default_with_note(self):
        for bad in (None, float("nan"), float("inf"), -float("inf"), np.nan):
            w: list[str] = []
            assert to_finite_float(bad, 0.5, label="x", warnings=w) == 0.5
            assert len(w) == 1

    def test_single_item_list_unwraps_with_warning(self):
        w: list[str] = []
        assert to_finite_float([4.5], None, label="iso", warnings=w) == 4.5
        assert any("unwrapped" in m for m in w)

    def test_multi_item_list_rejected_never_multiplied(self):
        w: list[str] = []
        assert to_finite_float([1, 2, 3], 0.0, label="counts", warnings=w) == 0.0
        assert any("aggregate" in m.lower() for m in w)

    def test_dict_rejected(self):
        w: list[str] = []
        assert to_finite_float({"a": 1}, None, label="d", warnings=w) is None
        assert len(w) == 1

    def test_non_numeric_string_rejected(self):
        assert to_finite_float("kaboom", 9.0) == 9.0


class TestNormalize01:
    def test_bounds_and_direction(self):
        assert normalize_0_1(5, 0, 10) == 0.5
        assert normalize_0_1(5, 0, 10, "negative") == 0.5
        assert normalize_0_1(100, 0, 10) == 1.0
        assert normalize_0_1(-5, 0, 10) == 0.0
        assert normalize_0_1(0, 0, 10, "negative") == 1.0

    def test_degenerate_range_and_bad_value_stay_finite(self):
        for v, lo, hi in [(5, 3, 3), (float("nan"), 0, 10), ([1, 2], 0, 10)]:
            out = normalize_0_1(v, lo, hi)
            assert isinstance(out, float) and math.isfinite(out)
            assert 0.0 <= out <= 1.0


class TestAggregateProviderValues:
    def test_methods(self):
        vals = [2.0, 4.0, 6.0]
        assert aggregate_provider_values(vals, "count") == 3.0
        assert aggregate_provider_values(vals, "sum") == 12.0
        assert aggregate_provider_values(vals, "mean") == 4.0
        assert aggregate_provider_values(vals, "min") == 2.0
        assert aggregate_provider_values(vals, "max") == 6.0
        assert aggregate_provider_values(vals, "nearest_distance") == 2.0

    def test_skips_non_numeric_items(self):
        w: list[str] = []
        assert aggregate_provider_values([1.0, "x", None, 3.0], "sum", warnings=w) == 4.0

    def test_empty_is_zero(self):
        assert aggregate_provider_values([], "count") == 0.0
        assert aggregate_provider_values(None, "mean") == 0.0


class TestFactorValueContract:
    def test_valid_value(self):
        v = FactorValue(hex_id="h1", raw_value=4, normalized_score=0.7,
                        evidence_count=4)
        assert v.raw_value == 4.0 and v.normalized_score == 0.7

    def test_multi_value_list_in_normalized_score_rejected(self):
        with pytest.raises(ContractViolation):
            FactorValue(hex_id="h1", raw_value=1.0, normalized_score=[0.2, 0.9])

    def test_list_in_raw_value_rejected(self):
        with pytest.raises(ContractViolation):
            FactorValue(hex_id="h1", raw_value=[1, 2, 3], normalized_score=0.5)

    def test_out_of_range_or_non_finite_rejected(self):
        for bad in (1.5, -0.1, float("nan"), float("inf")):
            with pytest.raises(ContractViolation):
                FactorValue(hex_id="h1", raw_value=None, normalized_score=bad)

    def test_validate_factor_result(self):
        ok = FactorResult(factor_id="f1", values=[
            FactorValue(hex_id="h1", raw_value=2.0, normalized_score=0.4),
        ])
        assert validate_factor_result(ok) == []
        bad = FactorResult(factor_id="f1", values=[], confidence="X",
                           degraded=True, degradation_reason=None)
        problems = validate_factor_result(bad)
        assert any("confidence" in p for p in problems)
        assert any("degradation_reason" in p for p in problems)


def test_factor_results_from_layer_scores_degrades_poisoned_refined():
    """A provider that stuffed a LIST into a refined value must degrade that
    hex's factor (warning + neutral), never raise into the composite."""
    spec, scores = _minimal_spec_and_scores()
    scores["student_catchment"].refined[1] = [999, 123]   # poison
    warnings: list[str] = []
    frs, violations = contracts.factor_results_from_layer_scores(
        spec, scores, [0, 1, 2],
        hexes=[SimpleNamespace(h3_id=f"h{i}") for i in range(3)],
        warnings=warnings,
    )
    assert len(frs) == 2
    for fr in frs:
        assert validate_factor_result(fr) == []
        for v in fr.values:
            assert 0.0 <= v.normalized_score <= 1.0
    assert any("list" in w.lower() for w in warnings)


def test_safe_int_sum_skips_lists():
    assert safe_int_sum({"a": 2, "b": ["x"], "c": 3.0}, ["a", "b", "c"]) == 5


# ── 3. _degradable_call: retry / timeout / breaker ────────────────────────────

def test_degradable_call_retries_transient_failure_then_succeeds():
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return "ok"

    fallbacks, degraded = [], []
    out = asyncio.run(_degradable_call(
        lambda: flaky(), timeout=5, label="places_test", job=_job(),
        fallbacks=fallbacks, degraded=degraded, default=None, retries=1,
    ))
    assert out == "ok"
    assert calls["n"] == 2
    assert degraded == []          # recovered — not degraded


def test_degradable_call_timeout_is_never_retried():
    calls = {"n": 0}

    async def slow():
        calls["n"] += 1
        await asyncio.sleep(5)

    fallbacks, degraded = [], []
    out = asyncio.run(_degradable_call(
        lambda: slow(), timeout=0.05, label="places_slow", job=_job(),
        fallbacks=fallbacks, degraded=degraded, default="D", retries=3,
    ))
    assert out == "D"
    assert calls["n"] == 1         # timeouts must not stack against the job budget
    assert degraded == ["places_slow"]


def test_degradable_call_circuit_breaker_opens_after_threshold():
    breaker = ProviderBreaker(threshold=2)
    calls = {"n": 0}

    async def broken():
        calls["n"] += 1
        raise RuntimeError("dead provider")

    fallbacks, degraded = [], []

    async def run_all():
        for i in range(4):
            await _degradable_call(
                lambda: broken(), timeout=5, label=f"places_{i}", job=_job(),
                fallbacks=fallbacks, degraded=degraded, default=[],
                breaker=breaker,
            )

    asyncio.run(run_all())
    assert calls["n"] == 2                      # calls 3+4 short-circuited
    assert breaker.is_open("places_anything")
    assert len(degraded) == 4                   # every call recorded as degraded
    assert any("circuit" in f.lower() for f in fallbacks)


def test_degradable_call_never_swallows_cancellation_with_factory():
    async def cancelled():
        raise JobCancelled()

    with pytest.raises(JobCancelled):
        asyncio.run(_degradable_call(
            lambda: cancelled(), timeout=5, label="x_y", job=_job(),
            fallbacks=[], degraded=[], default=None, retries=2,
        ))


# ── 4. Three-state result contract ─────────────────────────────────────────────

def test_exception_produces_structured_failed_payload():
    job = _job()
    job.phase = "score_pass_a"

    async def _raises(job, spec):
        raise TypeError("unsupported operand type(s) for +: 'int' and 'list'")

    fake_settings = type("S", (), {"job_max_runtime_seconds": 240})()
    with patch.object(jobs_mod, "_run_analysis", new=_raises), \
         patch.object(jobs_mod, "get_settings", return_value=fake_settings):
        jobs_mod._run_in_thread(job, spec=None)

    assert job.status == "error"
    r = job.result
    assert r is not None and r["status"] == "failed"
    assert r["status"] in RESULT_STATES
    assert r["stage"] == "score_pass_a"
    assert r["errorCode"] == "TypeError"
    assert r["jobRef"] == job.id[:8]
    assert r["retryable"] is False              # code defect — retrying won't help
    assert "int" not in r["userMessage"] or "jobRef" in r["userMessage"]


def test_timeout_produces_structured_failed_payload():
    job = _job()
    job.phase = "buildability"

    async def _hangs(job, spec):
        await asyncio.sleep(5)

    fake_settings = type("S", (), {"job_max_runtime_seconds": 0.05})()
    with patch.object(jobs_mod, "_run_analysis", new=_hangs), \
         patch.object(jobs_mod, "get_settings", return_value=fake_settings):
        jobs_mod._run_in_thread(job, spec=None)

    assert job.status == "timeout"
    r = job.result
    assert r["status"] == "failed"
    assert r["errorCode"] == "JOB_TIMEOUT"
    assert r["retryable"] is True
    assert r["stage"] == "buildability"
    assert r["jobRef"] == job.id[:8]


def test_failed_result_shape():
    r = _failed_result(_job(), stage="fetch", error_code="RuntimeError",
                       user_message="m", retryable=True)
    for key in ("status", "analysisId", "stage", "errorCode", "userMessage",
                "retryable", "providerDiagnostics", "jobRef"):
        assert key in r
    assert r["status"] == "failed"


# ── 5. End-to-end cafe / riverside with mocked degrading providers ────────────

def _study_polygon() -> ShapelyPolygon:
    # ~2 km box around Ruby Crossing, Kolkata
    return ShapelyPolygon([
        (88.395, 22.505), (88.415, 22.505), (88.415, 22.525), (88.395, 22.525),
    ])


def _pois(n: int, lat0=22.510, lng0=88.400, dlat=0.002, dlng=0.002) -> list[dict]:
    return [
        {"lat": lat0 + (i % 5) * dlat, "lng": lng0 + (i // 5) * dlng, "tags": {"name": f"p{i}"}}
        for i in range(n)
    ]


def _run_pipeline(spec, *, river_line: bool = False):
    """Run the full _run_analysis with mocked providers, forcing BOTH
    degradation lists (buildabilityDegraded via named-feature failures,
    providerDegraded via Places failures) — the exact preconditions of the
    v1.4.6 production crash."""
    job = _job()

    async def fake_resolve_study_area(area):
        return _study_polygon(), []

    async def fake_fetch_all_layers(tag_sets, bbox):
        return {lid: _pois(12) for lid in tag_sets}

    async def fake_fetch_places_pois(types, keyword, bbox):
        raise RuntimeError("Places API 500")          # → providerDegraded

    async def fake_fetch_area_geometries(tags, bbox):
        return []                                     # no water polygons / rail areas

    async def fake_fetch_line_geometries(tags, bbox):
        if river_line and any("water" in t or "river" in t for t in tags):
            # a river line crossing the study box west→east
            return [{"geometry": [
                {"lat": 22.515, "lng": 88.394}, {"lat": 22.515, "lng": 88.416},
            ]}]
        return []

    async def fake_fetch_named_features(regex, bbox):
        raise asyncio.TimeoutError()                  # → buildabilityDegraded

    async def fake_fetch_isochrones(cells, mode, minutes):
        return {}

    async def fake_reverse_geocode(lat, lng):
        return "Test Zone"

    async def fake_geocode(q):
        return (22.515, 88.405)

    async def fake_critique(*a, **k):
        return None

    async def fake_write_explanations(spec_, locations, ds=None):
        return "test summary", ["r"] * len(locations)

    # v1.4.8 — the Places priority chain (New → legacy) is stubbed to call the
    # legacy fetch directly so these tests exercise the SAME degradation path
    # as before and never touch the network. All-provider failure returns the
    # ("none" source) sentinel, which jobs maps to providerDegraded.
    async def fake_pois_with_fallback(types, keyword, bbox, *, legacy_fetch, ctx=None):
        try:
            pois = await legacy_fetch(types or [], keyword, bbox)
            return pois, "google_places_legacy", []
        except Exception as ex:
            return [], "none", [f"legacy failed: {ex}"]

    from app.providers.base import ProviderResult as _PR

    async def fake_aggregate_count(center, radius_m, included_types, *, ctx=None):
        return _PR(provider="gaggregate", feature="insight_count",
                   status="disabled", data={},
                   degradation_reason="api_not_available_http_403")

    from app.engine import results as results_mod

    with patch.object(jobs_mod, "resolve_study_area", fake_resolve_study_area), \
         patch.object(jobs_mod, "fetch_all_layers", fake_fetch_all_layers), \
         patch.object(jobs_mod, "fetch_places_pois", fake_fetch_places_pois), \
         patch.object(jobs_mod.gp_new, "fetch_pois_with_fallback", fake_pois_with_fallback), \
         patch.object(jobs_mod.gp_agg, "compute_count", fake_aggregate_count), \
         patch.object(jobs_mod, "fetch_area_geometries", fake_fetch_area_geometries), \
         patch.object(jobs_mod, "fetch_line_geometries", fake_fetch_line_geometries), \
         patch.object(jobs_mod, "fetch_named_features", fake_fetch_named_features), \
         patch.object(jobs_mod, "fetch_isochrones", fake_fetch_isochrones), \
         patch.object(jobs_mod, "reverse_geocode_name", fake_reverse_geocode), \
         patch.object(jobs_mod, "geocode", fake_geocode), \
         patch.object(jobs_mod, "critique_analysis", fake_critique), \
         patch.object(results_mod, "write_explanations", fake_write_explanations):
        asyncio.run(jobs_mod._run_analysis(job, spec))
    return job


def _cafe_spec():
    """Cafe test prompt spec — commercial businessType so ALL buildability
    flags fire (the degraded checks then put LISTS into mask_stats)."""
    from app.models.spec import SpecV2
    return SpecV2.model_validate({
        "version": "2.2",
        "objective": "Find the top 3 locations for a quick-service cafe targeting "
                     "students near the Ruby crossing and the EM Bypass",
        "businessType": "quick-service cafe",
        "studyArea": {"type": "places", "places": ["Ruby Crossing, Kolkata"]},
        "layers": [
            {
                "id": "students", "name": "Student catchment",
                "weight": 0.5, "direction": "positive",
                "source": {"provider": "osm", "tags": ["amenity=school", "amenity=college"]},
                "catchment": {"type": "walk", "minutes": 10},
                "normalization": {"method": "minmax"}, "confidence": "medium",
            },
            {
                "id": "cafes", "name": "Direct cafe competition",
                "weight": 0.5, "direction": "negative",
                "source": {"provider": "google_places", "types": ["cafe"]},
                "catchment": {"type": "walk", "minutes": 8},
                "normalization": {"method": "minmax"}, "confidence": "high",
            },
        ],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3, "minCandidateSeparationHexRings": 1},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": True, "refineTopK": 6},
        "plan": {"businessArchetype": "qsr_cafe", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    })


def _riverside_spec():
    from app.models.spec import SpecV2
    return SpecV2.model_validate({
        "version": "2.2",
        "objective": "Identify the 3 best sites for a premium riverside restaurant "
                     "along the Hooghly River between Howrah Bridge and Vidyasagar Setu",
        "businessType": "premium riverside restaurant",
        "studyArea": {"type": "places", "places": ["Howrah Bridge, Kolkata", "Vidyasagar Setu, Kolkata"]},
        "layers": [
            {
                "id": "affluence", "name": "Premium co-tenancy",
                "weight": 0.6, "direction": "positive",
                "source": {"provider": "osm", "tags": ["shop=mall", "amenity=restaurant"]},
                "catchment": {"type": "walk", "minutes": 10},
                "normalization": {"method": "minmax"}, "confidence": "medium",
            },
            {
                "id": "competition", "name": "Restaurant competition",
                "weight": 0.4, "direction": "negative",
                "source": {"provider": "google_places", "types": ["restaurant"]},
                "catchment": {"type": "walk", "minutes": 10},
                "normalization": {"method": "minmax"}, "confidence": "high",
            },
        ],
        "exclusions": [],
        "corridors": [{
            "name": "riverfront_band",
            "source": {"provider": "osm", "tags": ["waterway=river"]},
            "maxDistanceM": 500, "mode": "include",
        }],
        "routeConstraints": [],
        "waterfront": {"isWaterfront": True, "strictness": "strict",
                       "corridorWidthM": 500, "corridorSource": "llm"},
        "output": {"topN": 3, "minCandidateSeparationHexRings": 1},
        "grid": {"resolution": 9},
        "execution": {"isochroneRefinement": False, "refineTopK": 6},
        "plan": {"businessArchetype": "premium_restaurant", "methodology": "MCDA"},
        "meta": {"unsupportedRequests": []},
    })


def test_cafe_pipeline_with_degraded_providers_completes():
    """Cafe prompt + degraded Places + degraded buildability (the exact
    v1.4.6 crash preconditions: LISTS in mask_stats) must complete with a
    valid three-state payload — never an int+list TypeError."""
    job = _run_pipeline(_cafe_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] in RESULT_STATES
    assert r["jobRef"] == job.id[:8]
    # The degradation lists must be present (regression preconditions held)…
    assert r["maskStats"].get("providerDegraded"), "expected degraded providers"
    # …and the evidence trail still assembled.
    assert "evidenceTrail" in r
    assert isinstance(r["degradationNotes"], list) and r["degradationNotes"]
    assert r["providerDiagnostics"]["degradationCount"] >= 1


def test_riverside_pipeline_with_degraded_providers_completes():
    """Riverside prompt (waterfront corridor + water-geometry failure +
    degraded Places) must complete in one of the three payload states."""
    job = _run_pipeline(_riverside_spec(), river_line=True)
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] in RESULT_STATES
    assert r["jobRef"] == job.id[:8]
    if r["status"] == "no_viable_site":
        assert isinstance(r["failedGates"], list)
        assert isinstance(r["relaxationSuggestions"], list)
    assert "providerDiagnostics" in r


# ── 6. Product-correctness gates ───────────────────────────────────────────────

def test_supermarket_rent_and_footprint_marked_unverified():
    from app.engine.constraint_policy import evaluate_constraint_policy
    from app.models.spec import SpecV2

    spec = SpecV2.model_validate({
        "version": "2.2",
        "objective": "3 best locations for a massive 10,000 sq ft discount "
                     "supermarket in Sector V; rent cannot exceed ₹20/sq ft",
        "businessType": "discount supermarket",
        "studyArea": {"type": "places", "places": ["Sector V, Kolkata"]},
        "layers": [{
            "id": "l1", "name": "Arterial proximity", "weight": 1.0,
            "direction": "positive",
            "source": {"provider": "osm", "tags": ["highway=primary"]},
            "catchment": {"type": "euclidean", "meters": 500},
            "normalization": {"method": "minmax"}, "confidence": "high",
        }],
        "exclusions": [], "corridors": [], "routeConstraints": [],
        "output": {"topN": 3}, "grid": {"resolution": 8},
        "execution": {}, "plan": {"businessArchetype": "large_format_retail"},
        "meta": {"unsupportedRequests": []},
    })
    policy = evaluate_constraint_policy(spec=spec, locations=[])
    unverified = " ".join(policy.unverifiedHardConstraints).lower()
    assert "rent" in unverified
    assert "floor area" in unverified or "footprint" in unverified
    assert policy.constraintEnforcementLevel in ("provisional", "failed")
    assert policy.hasUnverifiableConstraints


def test_dark_kitchen_never_silently_euclidean():
    """A strict drive-time prompt with NO routing provider must declare the
    constraint unenforced (→ withheld/provisional), never silently pass on a
    Euclidean proxy."""
    from app.engine.route_policy import validate_strict_route_constraints
    from app.models.spec import SpecV2

    spec = SpecV2.model_validate({
        "version": "2.2",
        "objective": "Dark kitchen exactly within a 10-minute delivery drive of "
                     "Ballygunge Phari, strictly outside 1km of any metro station",
        "businessType": "dark kitchen",
        "studyArea": {"type": "places", "places": ["South Kolkata"]},
        "layers": [{
            "id": "demand", "name": "Residential delivery demand", "weight": 1.0,
            "direction": "positive",
            "source": {"provider": "osm", "tags": ["building=residential"]},
            "catchment": {"type": "drive", "minutes": 12},
            "normalization": {"method": "minmax"}, "confidence": "medium",
        }],
        "exclusions": [], "corridors": [],
        "routeConstraints": [],   # LLM FAILED to encode the strict route
        "output": {"topN": 3}, "grid": {"resolution": 9},
        "execution": {}, "plan": {"businessArchetype": "dark_kitchen"},
        "meta": {"unsupportedRequests": []},
    })
    check = validate_strict_route_constraints(
        spec=spec,
        raw_intent_dict={
            "rawPrompt": spec.objective,
            "hardConstraintPhrases": ["exactly within a 10-minute delivery drive"],
            "hasStrictRouteConstraint": True,
        },
        has_ors=False,
        has_google_routes=False,
    )
    assert not check.ok
    assert check.to_route_unavailable_entries()
