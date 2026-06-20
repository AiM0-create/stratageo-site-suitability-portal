"""Buildability / no-construction masks (Spatial Reliability Upgrade v1.0.3)."""
from app.engine import buildability
from app.engine.grid import HexCell

# A square polygon ~ lng 88.34–88.35, lat 22.55–22.56 (closed way).
SQUARE = {"geometry": [
    {"lat": 22.55, "lng": 88.34}, {"lat": 22.55, "lng": 88.35},
    {"lat": 22.56, "lng": 88.35}, {"lat": 22.56, "lng": 88.34},
    {"lat": 22.55, "lng": 88.34},
]}
# A short line segment along lat 22.5550 (e.g. a rail track).
LINE = {"geometry": [{"lat": 22.5550, "lng": 88.340}, {"lat": 22.5550, "lng": 88.360}]}


def _hx(lat, lng):
    return HexCell(h3_id=f"{lat},{lng}", lat=lat, lng=lng)


def test_centroid_in_polygon_mask():
    hexes = [_hx(22.555, 88.345), _hx(22.60, 88.40)]  # inside, outside
    mask = buildability.centroid_in_polygon_mask(hexes, [SQUARE])
    assert mask.tolist() == [True, False]


def test_centroid_in_polygon_mask_no_features():
    assert buildability.centroid_in_polygon_mask([_hx(22.555, 88.345)], []).tolist() == [False]


def test_line_buffer_mask():
    # 0.0005° ≈ 55 m off the line → within 40 m? no. On the line → yes.
    on_line = _hx(22.5550, 88.350)
    off_line = _hx(22.5570, 88.350)  # ~220 m north
    mask = buildability.line_buffer_mask([on_line, off_line], [LINE], 40.0, 22.555, 88.35)
    assert mask.tolist() == [True, False]


def test_point_buffer_mask_ghat():
    ghats = [{"lat": 22.5560, "lng": 88.3500, "name": "Some Ghat"}]
    near = _hx(22.5561, 88.3500)   # ~11 m
    far = _hx(22.5600, 88.3500)    # ~440 m
    mask = buildability.point_buffer_mask([near, far], ghats, 50.0)
    assert mask.tolist() == [True, False]


def test_commercial_viability_flags():
    cand = [0, 1]
    hexes = [_hx(22.5550, 88.3500), _hx(22.9000, 88.9000)]
    pois = [{"lat": 22.5551, "lng": 88.3500}]   # ~11 m from hex 0, far from hex 1
    status = buildability.commercial_viability(hexes, cand, [], pois, 22.555, 88.35)
    assert status[0] == "viable"   # has a POI within 200 m
    assert status[1] == "weak"     # nothing nearby, no roads given
