"""v1.11.3 — the open sea must be excluded, not just rivers and lakes.

Live failure: a "high-end gym in South Mumbai" run returned candidate zones
sitting in the Arabian Sea off Malabar Point.

Root cause: the water mask fetched natural=water / waterway=* — which covers
rivers, lakes, docks and ponds, all mapped as AREAS in OSM — but **the ocean is
not a polygon in OpenStreetMap**. The sea is defined implicitly by
`natural=coastline` ways, so a coastal city fetched zero geometry for the sea
itself and every offshore hex survived the mask. Adding the tag alone would not
have helped either: a coastline is an OPEN line and never polygonizes into a
ring, so build_water_polygons would still have produced nothing.

The fix uses OSM's coastline convention — a coastline way is directed so LAND
is on its LEFT and SEA on its RIGHT — to cut the study bbox and label the
resulting faces.
"""
import h3
import pytest

from app.engine.grid import HexCell
from app.engine.water import build_sea_polygons, sea_overlap_mask

# South-Mumbai-like frame: a N-S coast at lng 72.79, land east, sea west.
BBOX = (18.89, 72.77, 18.96, 72.83)   # (south, west, north, east)
COAST_LNG = 72.790


def _coastline(lats, lng=COAST_LNG):
    """A coastline way. Extends beyond the bbox, as real OSM ways do."""
    return {
        "tags": {"natural": "coastline"},
        "geometry": [{"lat": la / 10000.0, "lng": lng} for la in lats],
    }


# Travelling SOUTH: left (=land) is east, so the sea is WEST.
SOUTHWARD = _coastline(range(189800, 188700, -100))
# Travelling NORTH: the same line with the sea on the EAST instead.
NORTHWARD = _coastline(range(188700, 189800, 100))


def _cell(lat, lng, res=9):
    cid = h3.latlng_to_cell(lat, lng, res)
    la, ln = h3.cell_to_latlng(cid)
    ring = [[p[0], p[1]] for p in h3.cell_to_boundary(cid)]
    return HexCell(h3_id=cid, lat=la, lng=ln), ring


class TestSeaPolygonDerivation:
    def test_land_on_left_rule_puts_sea_west(self):
        sea = build_sea_polygons([SOUTHWARD], BBOX)
        assert sea, "coastline crossing the bbox must yield a sea face"
        assert all(p.bounds[2] <= COAST_LNG + 1e-4 for p in sea)

    def test_reversing_the_way_flips_which_side_is_sea(self):
        """Proves the convention is really applied, not accidentally right."""
        sea = build_sea_polygons([NORTHWARD], BBOX)
        assert sea
        assert all(p.bounds[0] >= COAST_LNG - 1e-4 for p in sea)

    def test_sea_never_covers_the_whole_study_area(self):
        for way in (SOUTHWARD, NORTHWARD):
            total = sum(p.area for p in build_sea_polygons([way], BBOX))
            box_area = (BBOX[2] - BBOX[0]) * (BBOX[3] - BBOX[1])
            assert 0 < total < box_area


class TestFailSafe:
    """Masking LAND by mistake deletes valid candidates — far worse than
    missing some sea. Every ambiguous case must mask nothing."""

    def test_no_coastline_returns_nothing(self):
        assert build_sea_polygons([], BBOX) == []

    def test_inland_city_with_no_coastline_tag_is_untouched(self):
        river_only = [{"tags": {"natural": "water"}, "geometry": [
            {"lat": 18.92, "lng": 72.80}, {"lat": 18.93, "lng": 72.80}]}]
        assert build_sea_polygons(river_only, BBOX) == []

    def test_coastline_not_crossing_the_bbox_masks_nothing(self):
        """A way that dead-ends inside the area cannot divide land from sea."""
        stub = _coastline(range(189300, 189200, -10))
        assert build_sea_polygons([stub], BBOX) == []

    def test_degenerate_bbox_masks_nothing(self):
        assert build_sea_polygons([SOUTHWARD], (18.96, 72.83, 18.89, 72.77)) == []
        assert build_sea_polygons([SOUTHWARD], (18.9, 72.8, 18.9, 72.8)) == []

    def test_single_point_way_is_ignored(self):
        one = {"tags": {"natural": "coastline"},
               "geometry": [{"lat": 18.92, "lng": COAST_LNG}]}
        assert build_sea_polygons([one], BBOX) == []


class TestSeaOverlapMask:
    def test_offshore_cell_masked_inland_cell_kept(self):
        off, off_ring = _cell(18.92, 72.775)     # well west of the coast
        land, land_ring = _cell(18.92, 72.815)   # well east of the coast
        mask = sea_overlap_mask(
            [off, land], [SOUTHWARD], [off_ring, land_ring], BBOX, ratio=0.30,
        )
        assert bool(mask[0]) is True
        assert bool(mask[1]) is False

    def test_threshold_keeps_a_mostly_land_shoreline_cell(self):
        """A waterfront zone is legitimate — only >30% sea is removed, so a
        cell that merely touches the shore must survive."""
        land, ring = _cell(18.92, 72.815)
        mask = sea_overlap_mask([land], [SOUTHWARD], [ring], BBOX, ratio=0.30)
        assert not mask.any()

    def test_no_coastline_masks_nothing(self):
        cell, ring = _cell(18.92, 72.775)
        assert not sea_overlap_mask([cell], [], [ring], BBOX).any()

    def test_missing_boundaries_masks_nothing(self):
        cell, _ = _cell(18.92, 72.775)
        assert not sea_overlap_mask([cell], [SOUTHWARD], [], BBOX).any()

    def test_mask_length_always_matches_hex_count(self):
        cells, rings = zip(*[_cell(18.92, lng) for lng in (72.775, 72.80, 72.815)])
        mask = sea_overlap_mask(list(cells), [SOUTHWARD], list(rings), BBOX)
        assert len(mask) == 3
