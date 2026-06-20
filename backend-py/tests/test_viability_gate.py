"""Spatial Reliability Upgrade v1.0.3 — viability-gate helpers in services.jobs."""
from app.models.spec import SpecV2
from app.services import jobs


def _spec(objective, business="restaurant"):
    return SpecV2(
        version="2.0", objective=objective, businessType=business,
        studyArea={"type": "places", "places": ["Howrah Bridge, Kolkata", "Vidyasagar Setu, Kolkata"]},
        layers=[{
            "id": "L1", "name": "Affluence", "weight": 100, "direction": "positive",
            "source": {"provider": "osm", "tags": ["shop=jewelry"]},
            "catchment": {"type": "euclidean", "meters": 500},
        }],
    )


def test_min_viable_score_tiers():
    assert jobs._min_viable_score(_spec("riverside restaurant strictly along the river")) == 5.0
    assert jobs._min_viable_score(_spec("premium retail store")) == 5.0
    # Non-commercial, non-waterfront, non-premium → default floor.
    assert jobs._min_viable_score(_spec("solar farm siting", business="solar farm")) == 4.5


def test_buildability_flags_waterfront_and_commercial():
    s = _spec("premium riverside restaurant strictly along the Hooghly")
    flags = jobs._buildability_flags(s)
    assert flags["railway"] and flags["ghat"] and flags["protected"] and flags["commercial_proxy"]


def test_buildability_flags_skip_non_commercial():
    s = _spec("solar farm siting on open land", business="solar farm")
    flags = jobs._buildability_flags(s)
    assert not flags["ghat"] and not flags["protected"]


def test_buildability_flags_avoid_railway_explicit():
    s = _spec("find a QSR near metro stations but avoid railway land", business="QSR")
    assert jobs._buildability_flags(s)["railway"] is True


def test_suggestions_keep_geography_and_widen_band():
    s = _spec("premium riverside restaurant strictly along the Hooghly")
    sug = jobs._viability_suggestions(s)
    joined = " ".join(sug).lower()
    assert "500 m" in joined or "500m" in joined         # widen the band
    assert "between" in joined                            # geographic constraint preserved
