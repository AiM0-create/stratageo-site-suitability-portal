"""v1.10.0 — Sensible Output: adaptive grid resolution + candidate separation.

Regression source: the live Sector V supermarket run — 6 grid cells at res 8
(2 eligible), top-3 requested but only 1 zone returned (the 2-ring separation
rule eliminated the rest), and a 6-value percentile stretch produced scores
like "0.0/10 despite 439 observed".
"""
from __future__ import annotations

import math

from shapely.geometry import Point

from app.engine.grid import polyfill
from app.services.jobs import adaptive_separation_rings

# Sector V, Kolkata-ish centre
LAT, LNG = 22.578, 88.433


def _small_polygon(radius_m: float):
    deg = radius_m / 111_320.0
    return Point(LNG, LAT).buffer(max(deg, radius_m / (111_320.0 * math.cos(math.radians(LAT)))))


class TestAdaptiveGridResolution:
    def test_small_area_refines_until_rankable(self):
        # ~1.5 km radius at res 8 ≈ a handful of cells → must refine upward.
        cells, res, notes = polyfill(_small_polygon(1500), 8, min_cells=40)
        assert len(cells) >= 40, "refined grid must be rankable"
        assert res > 8, "resolution must have been refined upward"
        assert res <= 10
        assert any("refined" in n for n in notes), "refinement must be disclosed"

    def test_large_area_unchanged(self):
        cells, res, notes = polyfill(_small_polygon(8000), 8, min_cells=40)
        assert res == 8
        assert not any("refined" in n for n in notes)
        assert len(cells) >= 40

    def test_no_min_cells_keeps_legacy_behaviour(self):
        cells, res, notes = polyfill(_small_polygon(1500), 8)
        assert res == 8, "min_cells=0 (default) must not change behaviour"

    def test_res10_floor_is_the_ceiling(self):
        # Even a very tiny polygon never refines past res 10.
        cells, res, _ = polyfill(_small_polygon(300), 8, min_cells=400)
        assert res == 10


class TestAdaptiveSeparation:
    def test_tiny_grid_drops_separation(self):
        assert adaptive_separation_rings(2, 2) == 0
        assert adaptive_separation_rings(14, 2) == 0

    def test_small_grid_caps_at_one_ring(self):
        assert adaptive_separation_rings(15, 2) == 1
        assert adaptive_separation_rings(59, 3) == 1

    def test_normal_grid_untouched(self):
        assert adaptive_separation_rings(60, 2) == 2
        assert adaptive_separation_rings(500, 2) == 2

    def test_never_raises_the_requested_value(self):
        assert adaptive_separation_rings(30, 1) == 1
        assert adaptive_separation_rings(10, 0) == 0
