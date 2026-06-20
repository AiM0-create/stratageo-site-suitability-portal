"""Spatial Reliability Upgrade v1.0.3.1 — corridor fallback, strict band,
maidan exclusion, competition-whitespace capping."""
from app.engine import buildability, corridors
from app.engine.grid import HexCell
from app.models.spec import SpecV2, detect_waterfront
from app.services import jobs


# ── PATCH 2 — stricter strict-band detection ────────────────────────────────
def test_riverside_alone_is_strict_250():
    wf = detect_waterfront("premium riverside restaurant in Kolkata")
    assert wf["isWaterfront"] and wf["strictness"] == "strict" and wf["targetWidthM"] == 250


def test_strictly_between_is_strict():
    wf = detect_waterfront("riverfront restaurant strictly between two bridges along the Hooghly")
    assert wf["strictness"] == "strict" and wf["targetWidthM"] == 250


def test_explicit_500_still_broad():
    wf = detect_waterfront("riverfront cafe, can consider up to 500 m from the river")
    assert wf["strictness"] == "broad" and wf["targetWidthM"] == 500


# ── PATCH 1 — water-polygon boundary works as a corridor fallback geometry ───
def test_distance_to_water_polygon_boundary_is_finite():
    # The riverbank fallback feeds water AREA features (polygon rings) into
    # distance_to_lines_m, which must measure distance to the ring (the bank).
    square = {"geometry": [
        {"lat": 22.55, "lng": 88.34}, {"lat": 22.55, "lng": 88.35},
        {"lat": 22.56, "lng": 88.35}, {"lat": 22.56, "lng": 88.34},
        {"lat": 22.55, "lng": 88.34},
    ]}
    near = HexCell("a", 22.5505, 88.345)   # just inside, ~near the south edge
    far = HexCell("b", 22.60, 88.40)       # ~5 km away
    d = corridors.distance_to_lines_m([near, far], [square], 22.555, 88.345)
    assert d[0] < d[1] and d[1] < float("inf")


# ── PATCH 2/3 — viability suggestions widen gradually & keep geography ───────
def _wf_spec(objective):
    return SpecV2(
        version="2.0", objective=objective, businessType="restaurant",
        studyArea={"type": "places", "places": ["Howrah Bridge, Kolkata", "Vidyasagar Setu, Kolkata"]},
        layers=[{"id": "L1", "name": "Affluence", "weight": 100, "direction": "positive",
                 "source": {"provider": "osm", "tags": ["shop=jewelry"]},
                 "catchment": {"type": "euclidean", "meters": 500}}],
    )


def test_strict_suggestions_widen_250_to_350_first():
    s = _wf_spec("premium riverside restaurant strictly along the Hooghly")
    assert s.waterfront.corridorWidthM == 250
    joined = " ".join(jobs._viability_suggestions(s)).lower()
    assert "350 m" in joined and "between" in joined


# ── PATCH 3 — open-ground / maidan exclusion tags + name pattern ─────────────
def test_protected_tags_include_open_space():
    for t in ("leisure=pitch", "leisure=garden", "natural=grassland", "landuse=village_green"):
        assert t in buildability.PROTECTED_AREA_TAGS


def test_maidan_name_regex_and_point_mask():
    import re
    assert re.search(buildability.OPEN_GROUND_NAME_RE, "Howrah Maidan")
    grounds = [{"lat": 22.5800, "lng": 88.3400, "name": "Brigade Parade Ground"}]
    near = HexCell("a", 22.5801, 88.3400)   # ~11 m
    far = HexCell("b", 22.6000, 88.3400)
    mask = buildability.point_buffer_mask([near, far], grounds, 75.0)
    assert mask.tolist() == [True, False]


# ── PATCH 4 — competition-whitespace capping ─────────────────────────────────
def _loc(demand, eco, comp):
    return {
        "name": "Tiretta Bazaar", "mcda_score": 0.0, "excluded": False,
        "criteria_breakdown": [
            {"name": "Premium demand", "weight": 0.34, "score": demand, "direction": "positive"},
            {"name": "F&B ecosystem", "weight": 0.33, "score": eco, "direction": "positive"},
            {"name": "Competition saturation", "weight": 0.33, "score": comp, "direction": "negative"},
        ],
    }


def test_competition_capped_when_demand_and_fnb_zero():
    spec = _wf_spec("premium riverside restaurant along the Hooghly")  # commercial
    loc = _loc(0.0, 0.0, 10.0)
    jobs._cap_competition_whitespace(spec, [loc])
    comp = next(c for c in loc["criteria_breakdown"] if c["name"] == "Competition saturation")
    assert comp["score"] == 3.0                      # capped from 10 → 3
    assert loc.get("competitionCapped") is True
    assert loc["mcda_score"] <= 3.3                   # composite no longer propped up


def test_competition_not_capped_when_demand_strong():
    spec = _wf_spec("premium riverside restaurant along the Hooghly")
    loc = _loc(7.0, 6.0, 10.0)
    jobs._cap_competition_whitespace(spec, [loc])
    comp = next(c for c in loc["criteria_breakdown"] if c["name"] == "Competition saturation")
    assert comp["score"] == 10.0                      # strong demand → no cap
    assert "competitionCapped" not in loc
