"""Buildability / no-construction exclusion masks (Spatial Reliability Upgrade v1.0.3).

The MCDA grid happily scores any hex whose centroid sits on land — including
railway yards, ghats, parks, graveyards and heritage land that are NOT buildable
commercial plots. This module adds DETERMINISTIC hard masks for those obvious
no-build classes, plus a soft commercial-frontage proxy.

Design rules (from the upgrade brief):
- Hard-exclude only OBVIOUS no-build land (rail/ghat/heritage/protected/open-space,
  heavy water overlap). OSM is incomplete in India, so we never invent buildability —
  absence of a mask is "unknown", not "buildable".
- The commercial proxy is a SOFT flag (viable/weak), never a hard gate by itself.
- Every mask returns a boolean array aligned to `hexes`; the caller ORs it into the
  global `excluded` array and reports the per-category count.

All distance math reuses the local equirectangular projection from corridors.py
(accurate at city scale), so callers pass the same (lat0, lng0) centre.
"""
from __future__ import annotations

import logging

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .corridors import distance_to_lines_m
from .grid import HexCell
from .scoring import haversine_m

logger = logging.getLogger(__name__)


# ── OSM tag sets per no-build / demand class (consumed by jobs.py fetches) ──
RAILWAY_AREA_TAGS = ["landuse=railway", "railway=yard", "railway=platform", "railway=station"]
RAILWAY_LINE_TAGS = ["railway=rail", "railway=light_rail", "railway=narrow_gauge", "railway=siding"]
# Hard no-build polygons: protected/heritage/open-space/sacred land.
PROTECTED_AREA_TAGS = [
    "leisure=park", "leisure=nature_reserve", "landuse=recreation_ground",
    "landuse=grass", "natural=wood", "natural=scrub", "boundary=protected_area",
    "historic=*", "heritage=*", "amenity=grave_yard", "landuse=cemetery",
    "amenity=place_of_worship",
]
# Lightweight road network for the commercial-frontage proxy.
ROAD_LINE_TAGS = [
    "highway=primary", "highway=secondary", "highway=tertiary",
    "highway=residential", "highway=living_street", "highway=unclassified",
]


def _polygons_from_features(features: list[dict]) -> list[Polygon]:
    """Closed ways → polygons; open relation-member fragments are assembled via
    polygonize. Same approach as engine/water.build_water_polygons but general."""
    from .water import build_water_polygons  # identical geometry assembly, reused
    return build_water_polygons(features)


def centroid_in_polygon_mask(hexes: list[HexCell], features: list[dict]) -> np.ndarray:
    """True where a hex centroid falls inside any feature polygon (hard no-build)."""
    mask = np.zeros(len(hexes), dtype=bool)
    polys = _polygons_from_features(features)
    if not polys:
        return mask
    merged = unary_union(polys)
    for i, h in enumerate(hexes):
        if merged.contains(Point(h.lng, h.lat)):
            mask[i] = True
    return mask


def line_buffer_mask(
    hexes: list[HexCell], lines: list[dict], buffer_m: float, lat0: float, lng0: float
) -> np.ndarray:
    """True where a hex centroid is within `buffer_m` of any line (e.g. rail tracks)."""
    if not lines:
        return np.zeros(len(hexes), dtype=bool)
    dists = distance_to_lines_m(hexes, lines, lat0, lng0)
    finite = np.isfinite(dists)
    mask = np.zeros(len(hexes), dtype=bool)
    mask[finite] = dists[finite] <= buffer_m
    return mask


def point_buffer_mask(hexes: list[HexCell], pois: list[dict], buffer_m: float) -> np.ndarray:
    """True where a hex centroid is within `buffer_m` of any POI (e.g. ghats)."""
    mask = np.zeros(len(hexes), dtype=bool)
    if not pois:
        return mask
    for i, h in enumerate(hexes):
        for p in pois:
            if haversine_m(h.lat, h.lng, p["lat"], p["lng"]) <= buffer_m:
                mask[i] = True
                break
    return mask


def commercial_viability(
    hexes: list[HexCell],
    candidate_indices: list[int],
    road_lines: list[dict],
    poi_points: list[dict],
    lat0: float,
    lng0: float,
    road_m: float = 120.0,
    poi_m: float = 200.0,
) -> dict[int, str]:
    """Soft commercial-frontage proxy for the shortlisted candidates only.

    'viable' if it has road access within `road_m` OR any built/commercial POI
    within `poi_m`; otherwise 'weak'. Never 'excluded' here — hard no-build land is
    removed upstream. Deliberately lenient (OSM under-maps Indian streets/POIs):
    this is a confidence signal, not a gate.
    """
    out: dict[int, str] = {}
    road_dists = (
        distance_to_lines_m([hexes[i] for i in candidate_indices], road_lines, lat0, lng0)
        if road_lines else None
    )
    for pos, ci in enumerate(candidate_indices):
        h = hexes[ci]
        has_road = bool(road_dists is not None and np.isfinite(road_dists[pos]) and road_dists[pos] <= road_m)
        has_poi = any(haversine_m(h.lat, h.lng, p["lat"], p["lng"]) <= poi_m for p in poi_points)
        out[ci] = "viable" if (has_road or has_poi) else "weak"
    return out
