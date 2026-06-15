"""Unit tests for linear-feature corridor gates (distance-to-LINE masking)."""
import numpy as np

from app.engine import corridors
from app.engine.grid import HexCell


def _hex(lat: float, lng: float) -> HexCell:
    return HexCell(h3_id=f"{lat:.4f},{lng:.4f}", lat=lat, lng=lng)


# A roughly N–S line near Gurgaon at lng≈77.05, spanning lat 28.45→28.50.
_WAY = {"geometry": [
    {"lat": 28.45, "lng": 77.05},
    {"lat": 28.50, "lng": 77.05},
]}


def test_build_lines_skips_degenerate():
    lines = corridors.build_lines(
        [_WAY, {"geometry": [{"lat": 28.47, "lng": 77.05}]}],  # 2nd has 1 pt
        28.475, 77.05,
    )
    assert len(lines) == 1  # the single-point "way" is dropped


def test_distance_is_metric_and_small_on_the_line():
    hexes = [_hex(28.475, 77.05)]  # sits ON the line
    d = corridors.distance_to_lines_m(hexes, [_WAY], 28.475, 77.05)
    assert d[0] < 5.0  # ~0 metres


def test_distance_grows_off_the_line():
    # ~0.02° of longitude east ≈ 0.02 * 111320 * cos(28.4°) ≈ 1960 m
    hexes = [_hex(28.475, 77.07)]
    d = corridors.distance_to_lines_m(hexes, [_WAY], 28.475, 77.05)
    assert 1500 < d[0] < 2400


def test_no_geometry_is_infinite_and_never_masks():
    hexes = [_hex(28.475, 77.05)]
    d = corridors.distance_to_lines_m(hexes, [], 28.475, 77.05)
    assert np.isinf(d[0])
    assert corridor_excluded(d, 5000, "include")[0] == False  # noqa: E712
    assert corridor_excluded(d, 5000, "exclude")[0] == False  # noqa: E712


def corridor_excluded(d, m, mode):
    return corridors.corridor_mask(d, m, mode)


def test_include_gate_excludes_far_hexes_only():
    # one near (on line), one far (~2 km east)
    d = np.array([3.0, 1960.0])
    mask = corridors.corridor_mask(d, 1000.0, "include")
    assert mask.tolist() == [False, True]  # near kept, far masked


def test_exclude_gate_excludes_near_hexes_only():
    d = np.array([3.0, 1960.0])
    mask = corridors.corridor_mask(d, 1000.0, "exclude")
    assert mask.tolist() == [True, False]  # near masked, far kept
