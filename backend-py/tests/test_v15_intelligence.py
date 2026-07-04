"""Analysis Intelligence v1.5 Lite tests.

Pins:
  - deterministic classification (businessArchetype / locationIntent /
    riskTriggers / analysisMode / hardGates / softFactors) for the four
    canonical prompts, and run-to-run stability of the classification;
  - scenario ranking stability labels (Part 7), including the
    not-enough-candidates case;
  - dataSufficiencyV2 + analysisIntelligence + analysisRecommendation in the
    success payload (Part 6/9), assembled with ZERO new provider calls;
  - unsupported constraints (rent/floorplate) keep the supermarket verdict
    below a strong recommendation;
  - dark kitchen reports network-verified routing.

Reuses the fully-mocked v1.4.9 pipeline harness — no network anywhere.
"""
from __future__ import annotations

import numpy as np

from app.engine.planner_lite import create_analysis_plan, _factor_family
from app.engine.scoring import LayerScores
from app.engine.stability import (
    LABEL_ROBUST, LABEL_STABLE, LABEL_SENSITIVE, LABEL_UNSTABLE, LABEL_TOO_FEW,
    SCENARIOS, compute_ranking_stability,
)

from test_v149_planner_lite import (
    _cafe_spec,
    _dark_kitchen_spec,
    _riverside_spec,
    _run_pipeline,
    _supermarket_spec,
)

ALL_LABELS = {LABEL_ROBUST, LABEL_STABLE, LABEL_SENSITIVE, LABEL_UNSTABLE, LABEL_TOO_FEW}


# ── Part 1: four-prompt classification ────────────────────────────────────────

def test_cafe_classification():
    intel = create_analysis_plan(_cafe_spec()).intelligence
    assert intel["businessArchetype"] == "food_footfall"
    assert intel["locationIntent"] == "near_anchor"
    assert intel["analysisMode"] == "fast_screening"
    assert "waterfront" not in intel["riskTriggers"]
    assert intel["unknownConstraints"] == []
    # soft factors carry family + support labels
    fams = {f["family"] for f in intel["softFactors"]}
    assert fams <= {"demand", "access", "competition", "cotenancy", "other"}


def test_riverside_classification():
    intel = create_analysis_plan(_riverside_spec()).intelligence
    assert intel["businessArchetype"] == "hospitality_destination"
    assert intel["locationIntent"] == "riverfront_or_waterfront"
    assert intel["analysisMode"] == "strict_corridor"
    assert "waterfront" in intel["riskTriggers"]
    assert "strict_boundary" in intel["riskTriggers"]
    # the waterfront band is a declared hard gate
    assert any(g["gate"] == "waterfront_band" for g in intel["hardGates"])


def test_supermarket_classification():
    intel = create_analysis_plan(_supermarket_spec()).intelligence
    assert intel["businessArchetype"] == "large_format_retail"
    assert intel["analysisMode"] == "large_format_screening"
    for trigger in ("rent_cap", "large_floorplate", "primary_arterial_required"):
        assert trigger in intel["riskTriggers"], f"missing {trigger}"
    assert "rent_or_lease_price" in intel["unknownConstraints"]
    assert "floor_area_footprint" in intel["unknownConstraints"]


def test_dark_kitchen_classification():
    intel = create_analysis_plan(_dark_kitchen_spec()).intelligence
    assert intel["businessArchetype"] == "delivery_kitchen"
    assert intel["locationIntent"] == "within_travel_time"
    assert intel["analysisMode"] == "routing_required"
    assert "delivery_time_sensitive" in intel["riskTriggers"]
    assert any(g["type"] == "travel_time" and g["verification"] == "network_routing"
               for g in intel["hardGates"])


def test_classification_is_deterministic_across_runs():
    for build in (_cafe_spec, _riverside_spec, _supermarket_spec, _dark_kitchen_spec):
        a = create_analysis_plan(build()).intelligence
        b = create_analysis_plan(build()).intelligence
        assert a == b


# ── Part 7: scenario ranking stability ────────────────────────────────────────

def _stability_scores():
    """Two layers (demand-family + competition-family) over 3 candidates.
    Candidate 0 dominates both factors → robust; candidates 1/2 trade places."""
    spec = _cafe_spec()
    demand_layer, comp_layer = spec.layers[0], spec.layers[1]
    return {
        demand_layer.id: LayerScores(
            layer=demand_layer, raw=np.array([10.0, 6.0, 2.0]),
            norm_low=0.0, norm_high=10.0, has_data=True, proxy_radius_m=800.0),
        comp_layer.id: LayerScores(
            layer=comp_layer, raw=np.array([1.0, 8.0, 3.0]),
            norm_low=0.0, norm_high=10.0, has_data=True, proxy_radius_m=640.0),
    }


def test_stability_dominant_candidate_is_robust():
    out = compute_ranking_stability(_stability_scores(), [0, 1, 2])
    assert out[0]["stabilityLabel"] == LABEL_ROBUST
    assert set(out[0]["scenarioRanks"]) == set(SCENARIOS)
    assert all(v == 1 for v in out[0]["scenarioRanks"].values())
    for ci in (1, 2):
        assert out[ci]["stabilityLabel"] in ALL_LABELS
        assert out[ci]["note"]


def test_stability_single_candidate_says_not_enough():
    out = compute_ranking_stability(_stability_scores(), [0])
    assert out[0]["stabilityLabel"] == LABEL_TOO_FEW
    assert "not enough" in out[0]["note"].lower()


def test_stability_never_raises_on_garbage():
    assert compute_ranking_stability({}, []) == {}


def test_factor_family_classifier():
    assert _factor_family("Student catchment") == "demand"
    assert _factor_family("Residential delivery demand") == "demand"
    assert _factor_family("Direct cafe competition") == "competition"
    assert _factor_family("Pedestrian / transit access") == "access"
    assert _factor_family("Commercial co-tenancy") == "cotenancy"


# ── Part 6/9: payload contract via the mocked end-to-end pipeline ─────────────

def test_cafe_payload_carries_intelligence_sufficiency_and_labels():
    job, _ = _run_pipeline(_cafe_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] == "success"

    intel = r["analysisIntelligence"]
    assert intel["businessArchetype"] == "food_footfall"

    ds2 = r["dataSufficiencyV2"]
    assert ds2["geocoding"] == "verified"
    assert ds2["routing"] == "not_required"          # no travel-time constraint stated
    assert ds2["buildability_lite"] == "not_required"
    assert ds2["final_confidence"] in ("high", "medium", "low")
    assert ds2["confidence_reason"]
    assert ds2["external_provider_health"] in ("ok", "degraded")
    assert ds2["demand_data"] in ("verified", "proxy")   # OSM factor had data

    assert r["analysisRecommendation"] in (
        "RECOMMENDED_INVESTIGATION_ZONE", "PROVISIONAL_CANDIDATE",
        "WEAK_CANDIDATE", "NO_RELIABLE_RECOMMENDATION",
    )
    for loc in r["locations"]:
        assert loc["investigationLabel"]
        assert loc["stabilityLabel"] in ALL_LABELS
        if loc["stabilityLabel"] != LABEL_TOO_FEW:
            assert loc["scenarioRanks"]


def test_supermarket_unknowns_cap_the_verdict_below_recommended():
    job, _ = _run_pipeline(_supermarket_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    # rent + floorplate unknown → analysis verdict must not be the strong label
    assert r["analysisRecommendation"] != "RECOMMENDED_INVESTIGATION_ZONE"
    assert r["dataSufficiencyV2"]["hard_constraints"]["unknown_count"] >= 2
    assert r["dataSufficiencyV2"]["final_confidence"] in ("medium", "low")
    for loc in r["locations"]:
        if not loc.get("excluded"):
            assert loc["investigationLabel"] in ("PROVISIONAL_CANDIDATE", "WEAK_CANDIDATE")


def test_dark_kitchen_reports_network_verified_routing():
    job, _ = _run_pipeline(_dark_kitchen_spec())
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["analysisIntelligence"]["businessArchetype"] == "delivery_kitchen"
    assert r["dataSufficiencyV2"]["routing"] == "verified"
    # footfall never became a scoring factor — soft factors stay in the
    # delivery-relevant families
    fams = {f["family"] for f in r["analysisIntelligence"]["softFactors"]}
    assert "demand" in fams or "competition" in fams


def test_degraded_places_reflected_in_sufficiency():
    job, _ = _run_pipeline(_cafe_spec(), healthy_places=False)
    assert job.status == "done", f"job failed: {job.error}"
    r = job.result
    assert r["status"] == "success"                       # degradation ≠ failure
    assert r["dataSufficiencyV2"]["external_provider_health"] == "degraded"
    assert r["dataSufficiencyV2"]["final_confidence"] in ("medium", "low")
