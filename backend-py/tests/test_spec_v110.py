"""Tests for SpecV2 v1.1.0 backward-compatible extensions."""
import pytest
from pydantic import ValidationError
from app.models.spec import SpecV2, RawIntentMeta, OutputCount, ModelDisclosure, DataConfidence


def _base_spec(**overrides):
    """Return a minimal valid SpecV2 dict."""
    spec = {
        "version": "2.1",
        "objective": "Find a restaurant in Kolkata",
        "businessType": "restaurant",
        "studyArea": {"type": "places", "places": ["Salt Lake, Kolkata"]},
        "layers": [{
            "id": "L1", "name": "Demand", "weight": 100, "direction": "positive",
            "source": {"provider": "osm", "tags": ["amenity=restaurant"]},
            "catchment": {"type": "euclidean", "meters": 500},
        }],
    }
    spec.update(overrides)
    return spec


def test_spec_v21_accepted():
    spec = SpecV2(**_base_spec())
    assert spec.version == "2.1"


def test_spec_v20_still_accepted():
    """Old v2.0 analyses must continue to load."""
    spec = SpecV2(**_base_spec(version="2.0"))
    assert spec.version == "2.0"


def test_default_site_claim_level():
    spec = SpecV2(**_base_spec())
    assert spec.siteClaimLevel == "micro_market_zone"


def test_default_analysis_mode_is_none():
    spec = SpecV2(**_base_spec())
    assert spec.analysisMode is None  # LLM sets this


def test_default_recommendation_mode_is_none():
    spec = SpecV2(**_base_spec())
    assert spec.recommendationMode is None


def test_raw_intent_optional():
    spec = SpecV2(**_base_spec())
    assert spec.rawIntent is None


def test_raw_intent_round_trips():
    ri = RawIntentMeta(
        topNResolved=5, requestedTopNRaw=5, businessTypeKey="dark_kitchen",
        hardConstraintPhrases=["within 10 min of residential area"],
        spatialRelations=["within_drive_time"],
        featureClasses=["residential"],
        objectiveType="demand_maximization",
    )
    spec = SpecV2(**_base_spec(rawIntent=ri.model_dump()))
    assert spec.rawIntent.topNResolved == 5
    assert spec.rawIntent.businessTypeKey == "dark_kitchen"


def test_output_count_optional():
    spec = SpecV2(**_base_spec())
    assert spec.outputCount is None


def test_model_disclosure_optional():
    spec = SpecV2(**_base_spec())
    assert spec.modelDisclosure is None


def test_data_confidence_optional():
    spec = SpecV2(**_base_spec())
    assert spec.dataConfidence is None


def test_archetype_key_optional():
    spec = SpecV2(**_base_spec())
    assert spec.archetypeKey is None


def test_archetype_key_set():
    spec = SpecV2(**_base_spec(archetypeKey="qsr_restaurant"))
    assert spec.archetypeKey == "qsr_restaurant"


def test_top_n_default_from_output():
    spec = SpecV2(**_base_spec())
    assert spec.output.topN == 3


def test_weight_renormalization_preserved():
    """Existing weight renormalization must still work for backward compat."""
    spec = SpecV2(**_base_spec())
    assert abs(sum(l.weight for l in spec.layers) - 1.0) < 0.001


def test_analysis_modes_all_accepted():
    modes = [
        "micro_market_scoring", "catchment_accessibility", "network_coverage",
        "white_space_expansion", "logistics_access", "parcel_screening_proxy",
        "uploaded_candidate_ranking", "feasibility_only",
    ]
    for mode in modes:
        spec = SpecV2(**_base_spec(analysisMode=mode))
        assert spec.analysisMode == mode


def test_site_claim_levels_all_accepted():
    levels = ["parcel_site", "point_candidate", "micro_market_zone", "broad_area"]
    for level in levels:
        spec = SpecV2(**_base_spec(siteClaimLevel=level))
        assert spec.siteClaimLevel == level


def test_recommendation_modes_all_accepted():
    modes = ["recommended_sites", "candidate_zones", "raw_diagnostic", "no_reliable_recommendation"]
    for mode in modes:
        spec = SpecV2(**_base_spec(recommendationMode=mode))
        assert spec.recommendationMode == mode
