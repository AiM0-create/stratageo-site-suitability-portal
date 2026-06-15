"""Linear-feature proximity gates (v1.0.2).

"within 5 km of the highway", "away from the river", "along the rail corridor"
target a LINE, not a point. Counting a road as POI centroids floors a scoring
layer to ~0 (a multi-km way reduces to a single centroid), so instead we fetch
the real way GEOMETRY, project to a local equirectangular metric frame (accurate
at city scale), and mask hexes by TRUE distance-to-nearest-line.

    include → keep only hexes WITHIN maxDistanceM of the line (must be near it)
    exclude → mask out hexes WITHIN maxDistanceM of the line (must be away from it)
"""
from __future__ import annotations

import logging
import math

import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

from .grid import HexCell

logger = logging.getLogger(__name__)

_M_PER_DEG_LAT = 111_320.0


def _projector(lat0: float, lng0: float):
    """Local equirectangular projection (lng,lat°) → (x,y metres) around a centre.
    Distortion is negligible over a single city's extent."""
    k = math.cos(math.radians(lat0)) * _M_PER_DEG_LAT

    def proj(lng: float, lat: float) -> tuple[float, float]:
        return ((lng - lng0) * k, (lat - lat0) * _M_PER_DEG_LAT)

    return proj


def build_lines(ways: list[dict], lat0: float, lng0: float) -> list[LineString]:
    """ways: [{geometry: [{lat,lng}, ...]}] from fetch_line_geometries."""
    proj = _projector(lat0, lng0)
    lines: list[LineString] = []
    for w in ways:
        pts = [
            proj(p["lng"], p["lat"])
            for p in (w.get("geometry") or [])
            if p.get("lat") is not None and p.get("lng") is not None
        ]
        if len(pts) >= 2:
            lines.append(LineString(pts))
    return lines


def distance_to_lines_m(
    hexes: list[HexCell], ways: list[dict], lat0: float, lng0: float
) -> np.ndarray:
    """Per-hex metric distance to the nearest line; inf when no geometry."""
    lines = build_lines(ways, lat0, lng0)
    if not lines:
        return np.full(len(hexes), np.inf)
    merged = unary_union(lines)            # single (Multi)LineString → C-level distance
    proj = _projector(lat0, lng0)
    out = np.empty(len(hexes))
    for i, h in enumerate(hexes):
        out[i] = Point(proj(h.lng, h.lat)).distance(merged)
    return out


def corridor_mask(distances_m: np.ndarray, max_distance_m: float, mode: str) -> np.ndarray:
    """True where the hex is EXCLUDED by this corridor.

    include → exclude hexes FARTHER than max (gate: must be near the line).
    exclude → exclude hexes CLOSER than max (gate: must be away from the line).
    Hexes with inf distance (no geometry) are never excluded — enforcement is
    skipped rather than nuking every candidate; the caller surfaces that.
    """
    finite = np.isfinite(distances_m)
    mask = np.zeros(len(distances_m), dtype=bool)
    if mode == "exclude":
        mask[finite] = distances_m[finite] <= max_distance_m
    else:  # include
        mask[finite] = distances_m[finite] > max_distance_m
    return mask
