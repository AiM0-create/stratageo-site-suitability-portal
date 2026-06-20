"""Unit tests for the water-body exclusion mask."""
from app.engine import water
from app.engine.grid import HexCell

# A square water body ~ lng 88.34–88.35, lat 22.55–22.56 (closed way: first==last,
# as OSM `out geom` returns closed ways).
SQUARE = {"geometry": [
    {"lat": 22.55, "lng": 88.34},
    {"lat": 22.55, "lng": 88.35},
    {"lat": 22.56, "lng": 88.35},
    {"lat": 22.56, "lng": 88.34},
    {"lat": 22.55, "lng": 88.34},
]}

# The SAME square split into two OPEN fragments (as a multipolygon relation's
# member ways arrive) — must be reassembled into a polygon via polygonize.
FRAG_A = {"geometry": [
    {"lat": 22.55, "lng": 88.34}, {"lat": 22.55, "lng": 88.35}, {"lat": 22.56, "lng": 88.35},
]}
FRAG_B = {"geometry": [
    {"lat": 22.56, "lng": 88.35}, {"lat": 22.56, "lng": 88.34}, {"lat": 22.55, "lng": 88.34},
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


def test_relation_fragments_are_assembled_into_a_polygon():
    # two open member ways forming a closed ring (the river-as-relation case)
    polys = water.build_water_polygons([FRAG_A, FRAG_B])
    assert len(polys) == 1 and polys[0].area > 0


def test_hex_inside_relation_assembled_water_is_masked():
    mask = water.water_mask([_hx(22.555, 88.345), _hx(22.60, 88.40)], [FRAG_A, FRAG_B])
    assert mask.tolist() == [True, False]


def test_water_overlap_mask_flags_mostly_water_hex():
    # v1.0.3 — a hex whose AREA is mostly inside the water polygon is masked even if
    # its centroid sits on the bank. boundaries are [[lat,lng],...] rings.
    inside = [[22.553, 88.343], [22.553, 88.347], [22.557, 88.347], [22.557, 88.343]]
    outside = [[22.60, 88.40], [22.60, 88.41], [22.61, 88.41], [22.61, 88.40]]
    hexes = [_hx(22.555, 88.345), _hx(22.605, 88.405)]
    mask = water.water_overlap_mask(hexes, [SQUARE], [inside, outside], ratio=0.30)
    assert mask.tolist() == [True, False]
