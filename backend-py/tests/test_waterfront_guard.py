"""Waterfront briefs must enforce 'along the river' as a corridor, not a dead
scoring layer (deterministic guard in SpecV2.validate_layers)."""
from app.models.spec import SpecV2


def _spec(objective: str, layers: list[dict]) -> SpecV2:
    return SpecV2(
        version="2.0", objective=objective, businessType="restaurant",
        studyArea={"type": "point_radius", "point": {"lat": 22.57, "lng": 88.34}, "radiusM": 3000},
        layers=layers,
    )


_RIVERSIDE_LAYER = {
    "id": "L1", "name": "Riverside proximity", "weight": 40, "direction": "positive",
    "source": {"provider": "osm", "tags": ["waterway=river"]},
    "catchment": {"type": "euclidean", "meters": 500},
}
_DIFFERENTIATOR = {
    "id": "L2", "name": "Affluent residential density", "weight": 30, "direction": "positive",
    "source": {"provider": "osm", "tags": ["building=residential"]},
    "catchment": {"type": "euclidean", "meters": 800},
}


def _has_water_corridor(s: SpecV2) -> bool:
    return any(
        any(t.startswith(("waterway", "natural=water", "water=", "natural=coastline")) for t in c.source.tags)
        for c in s.corridors
    )


def test_riverside_brief_injects_corridor_and_drops_dead_layer():
    s = _spec("premium riverside restaurant along the Hooghly River", [_RIVERSIDE_LAYER, _DIFFERENTIATOR])
    assert _has_water_corridor(s)
    names = [l.name for l in s.layers]
    assert "Riverside proximity" not in names      # dead waterfront layer dropped
    assert "Affluent residential density" in names  # genuine differentiator kept


def test_non_waterfront_brief_untouched():
    s = _spec("quick-service cafe near offices", [
        {"id": "L1", "name": "Office density", "weight": 100, "direction": "positive",
         "source": {"provider": "osm", "tags": ["office=*"]},
         "catchment": {"type": "euclidean", "meters": 800}},
    ])
    assert not _has_water_corridor(s)
    assert [l.name for l in s.layers] == ["Office density"]


def test_existing_water_corridor_not_duplicated():
    layers = [_DIFFERENTIATOR]
    s = SpecV2(
        version="2.0", objective="waterfront cafe along the river", businessType="cafe",
        studyArea={"type": "point_radius", "point": {"lat": 22.57, "lng": 88.34}, "radiusM": 3000},
        layers=layers,
        corridors=[{"name": "Bank", "source": {"provider": "osm", "tags": ["natural=water"]},
                    "maxDistanceM": 300, "mode": "include"}],
    )
    water_corridors = [c for c in s.corridors if _has_water_corridor(s)]
    assert len(s.corridors) == 1   # not duplicated
