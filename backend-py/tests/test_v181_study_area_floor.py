"""v1.8.1 — study-area minimum-extent floor.

Regression for the live JP Nagar 2nd Phase grocery failure: a "specific
intersections or blocks" brief made the LLM pick a tiny study area, the
deterministic planner bumped the grid to res 10, polyfill produced ~1 hex, a
single mask removed it, and the run reported a false "no viable site".

The type="places" path already floored to a 2 km buffer; type="point_radius"
and type="bbox" did not. These tests lock the floor for all three so a
degenerate study area can never collapse the grid.
"""
from __future__ import annotations

import asyncio
import math

import h3
from shapely.geometry import mapping

from app.engine.study_area import resolve_study_area, MIN_STUDY_AREA_RADIUS_M
from app.models.spec import StudyArea

# Approx JP Nagar 2nd Phase, Bengaluru
JP_LAT, JP_LNG = 12.9063, 77.5857


def _cells(poly, res: int) -> int:
    return len(h3.h3shape_to_cells(h3.geo_to_h3shape(mapping(poly)), res))


def _resolve(area: StudyArea):
    return asyncio.run(resolve_study_area(area))


class TestPointRadiusFloor:
    def test_tiny_radius_is_floored(self):
        # A 50 m radius would give ~1 hex at res 10 without the floor.
        area = StudyArea(type="point_radius",
                         point={"lat": JP_LAT, "lng": JP_LNG}, radiusM=50)
        poly, notes = _resolve(area)
        assert _cells(poly, 10) > 100, "floored radius must yield a usable res-10 grid"
        assert any("floored" in n.lower() for n in notes), "clamp must be disclosed"

    def test_generous_radius_untouched(self):
        area = StudyArea(type="point_radius",
                         point={"lat": JP_LAT, "lng": JP_LNG}, radiusM=5000)
        poly, notes = _resolve(area)
        # ~5 km radius; not floored, no clamp note
        assert not any("floored" in n.lower() for n in notes)
        assert _cells(poly, 8) > 100


class TestBboxFloor:
    def test_degenerate_bbox_is_expanded(self):
        # A ~60 m box → 1 hex at res 10 without the floor.
        d = 0.0003  # ~33 m
        area = StudyArea(type="bbox",
                         bbox=[JP_LNG - d, JP_LAT - d, JP_LNG + d, JP_LAT + d])
        poly, notes = _resolve(area)
        assert _cells(poly, 10) > 100
        assert any("expanded" in n.lower() for n in notes)

    def test_large_bbox_untouched(self):
        # ~3 km box — already above the floor.
        half = MIN_STUDY_AREA_RADIUS_M / 111_320.0 * 1.5
        area = StudyArea(type="bbox",
                         bbox=[JP_LNG - half, JP_LAT - half, JP_LNG + half, JP_LAT + half])
        poly, notes = _resolve(area)
        assert not any("expanded" in n.lower() for n in notes)


class TestFloorPreventsSingleHex:
    def test_no_study_area_type_collapses_to_one_hex_at_res_10(self):
        """The core invariant: no study-area type may yield a ~1-hex grid."""
        cases = [
            StudyArea(type="point_radius", point={"lat": JP_LAT, "lng": JP_LNG}, radiusM=40),
            StudyArea(type="bbox", bbox=[JP_LNG - 0.0002, JP_LAT - 0.0002,
                                         JP_LNG + 0.0002, JP_LAT + 0.0002]),
        ]
        for area in cases:
            poly, _ = _resolve(area)
            assert _cells(poly, 10) >= 50, f"{area.type} collapsed the grid"
