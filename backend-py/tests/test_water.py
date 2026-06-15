"""Unit tests for the water-body exclusion mask."""
from app.engine import water
from app.engine.grid import HexCell

# A square water body ~ lng 88.34–88.35, lat 22.55–22.56
SQUARE = {"geometry": [
    {"lat": 22.55, "lng": 88.34},
    {"lat": 22.55, "lng": 88.35},
    {"lat": 22.56, "lng": 88.35},
    {"lat": 22.56, "lng": 88.34},
]}


def _hx(lat, lng):
    return HexCell(h3_id=f"{lat},{lng}", lat=lat, lng=lng)


def test_polygon_built_from_closed_ring():
    polys = water.build_water_polygons([SQUARE])
    assert len(polys) == 1 and polys[0].area > 0


def test_hex_inside_water_is_masked_outside_is_kept():
    hexes = [_hx(22.555, 88.345), _hx(22.60, 88.40)]  # inside, outside
    mask = water.water_mask(hexes, [SQUARE])
    assert mask.tolist() == [True, False]


def test_no_water_features_means_no_mask():
    mask = water.water_mask([_hx(22.555, 88.345)], [])
    assert mask.tolist() == [False]


def test_degenerate_geometry_ignored():
    assert water.build_water_polygons([{"geometry": [{"lat": 1, "lng": 1}]}]) == []
