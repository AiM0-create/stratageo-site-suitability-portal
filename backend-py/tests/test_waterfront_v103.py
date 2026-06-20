"""Spatial Reliability Upgrade v1.0.3 — waterfront detection + corridor clamp."""
from app.models.spec import SpecV2, detect_waterfront


def test_detect_waterfront_tiers():
    strict = detect_waterfront("premium riverside restaurant strictly between two bridges")
    assert strict["isWaterfront"] and strict["strictness"] == "strict" and strict["targetWidthM"] == 250

    broad = detect_waterfront("restaurant near the riverfront, can consider up to 500 m from the river")
    assert broad["isWaterfront"] and broad["strictness"] == "broad" and broad["targetWidthM"] == 500

    normal = detect_waterfront("waterfront cafe by the Hooghly")
    assert normal["isWaterfront"] and normal["strictness"] == "normal" and normal["targetWidthM"] == 350

    none = detect_waterfront("quick-service cafe near offices in Sector V")
    assert not none["isWaterfront"]


def _spec(objective, corridors=None, layers=None):
    return SpecV2(
        version="2.0", objective=objective, businessType="restaurant",
        studyArea={"type": "point_radius", "point": {"lat": 22.57, "lng": 88.34}, "radiusM": 3000},
        layers=layers or [{
            "id": "L1", "name": "Affluence", "weight": 100, "direction": "positive",
            "source": {"provider": "osm", "tags": ["shop=jewelry"]},
            "catchment": {"type": "euclidean", "meters": 500},
        }],
        corridors=corridors or [],
    )


def test_loose_llm_corridor_is_clamped_on_strict_brief():
    # The audit's root cause: a loose 5000 m LLM corridor must be clamped to 250 m.
    s = _spec(
        "premium riverside restaurant strictly along the Hooghly River",
        corridors=[{"name": "Within Hooghly River corridor",
                    "source": {"provider": "osm", "tags": ["waterway=river"]},
                    "maxDistanceM": 5000, "mode": "include"}],
    )
    water = [c for c in s.corridors if any(t.startswith("waterway") for t in c.source.tags)]
    assert water[0].maxDistanceM == 250          # clamped down
    assert water[0].required is True             # hard gate
    assert s.waterfront.corridorSource == "clamped"
    assert s.waterfront.clampedFromM == 5000
    assert s.waterfront.corridorWidthM == 250


def test_corridor_injected_when_missing():
    s = _spec("riverside restaurant strictly between the bridges")
    water = [c for c in s.corridors if any(SpecV2 and t.startswith(("waterway", "natural=water", "water="))
                                           for t in c.source.tags)]
    assert water and water[0].maxDistanceM == 250
    assert s.waterfront.corridorSource == "injected"


def test_tighter_llm_corridor_not_loosened():
    s = _spec(
        "riverside cafe along the river",   # normal → target 350
        corridors=[{"name": "Bank", "source": {"provider": "osm", "tags": ["natural=water"]},
                    "maxDistanceM": 200, "mode": "include"}],
    )
    water = [c for c in s.corridors if any(t.startswith("natural=water") for t in c.source.tags)]
    assert water[0].maxDistanceM == 200          # kept strict, never loosened to 350
    assert s.waterfront.corridorWidthM == 200


def test_non_waterfront_brief_has_no_waterfront_meta():
    s = _spec("quick-service cafe near offices in Sector V")
    assert s.waterfront is None
