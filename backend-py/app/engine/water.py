"""Water-body exclusion (v1.0.2).

H3 polyfill tiles the entire study polygon — including the surface of rivers,
lakes and ponds. No business can sit in the water, so we fetch water-body
GEOMETRY (closed OSM ways), build polygons, and mask every hex whose centroid
falls inside one. This is what prevents "candidate in the middle of the Hooghly".
"""
from __future__ import annotations

import logging

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .grid import HexCell

logger = logging.getLogger(__name__)


def build_water_polygons(ways: list[dict]) -> list[Polygon]:
    """Closed OSM ways → shapely polygons (lng/lat; containment is projection-free)."""
    polys: list[Polygon] = []
    for w in ways:
        ring = [
            (p["lng"], p["lat"])
            for p in (w.get("geometry") or [])
            if p.get("lat") is not None and p.get("lng") is not None
        ]
        if len(ring) < 3:
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        try:
            poly = Polygon(ring)
            if poly.is_valid and poly.area > 0:
                polys.append(poly)
            else:
                fixed = poly.buffer(0)          # repair self-intersections
                if (not fixed.is_empty) and fixed.area > 0:
                    polys.append(fixed)
        except Exception:
            continue
    return polys


def water_mask(hexes: list[HexCell], ways: list[dict]) -> np.ndarray:
    """True where a hex centroid sits inside a water body."""
    polys = build_water_polygons(ways)
    mask = np.zeros(len(hexes), dtype=bool)
    if not polys:
        return mask
    merged = unary_union(polys)               # one C-level containment test per hex
    for i, h in enumerate(hexes):
        if merged.contains(Point(h.lng, h.lat)):
            mask[i] = True
    return mask
