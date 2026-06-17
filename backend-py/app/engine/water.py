"""Water-body exclusion (v1.0.2).

H3 polyfill tiles the entire study polygon — including the surface of rivers,
lakes and ponds. No business can sit in the water, so we fetch water-body
GEOMETRY (closed OSM ways), build polygons, and mask every hex whose centroid
falls inside one. This is what prevents "candidate in the middle of the Hooghly".
"""
from __future__ import annotations

import logging

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import polygonize, unary_union

from .grid import HexCell

logger = logging.getLogger(__name__)


def _clean(geom) -> list[Polygon]:
    out: list[Polygon] = []
    if geom is None or geom.is_empty:
        return out
    g = geom if geom.is_valid else geom.buffer(0)
    if g.is_empty or g.area <= 0:
        return out
    out.append(g)
    return out


def build_water_polygons(features: list[dict]) -> list[Polygon]:
    """Water features → shapely polygons (lng/lat; containment is projection-free).

    Handles two shapes: an already-closed way (pond/lake/dock — first==last node)
    becomes a polygon directly; OPEN fragments (the member ways of a multipolygon
    RELATION, e.g. a big river's bank split across several ways) are assembled into
    rings with shapely.polygonize. This is what lets the mask cover a river whose
    surface is a relation rather than a single tagged way.
    """
    polys: list[Polygon] = []
    fragments: list[LineString] = []
    for w in features:
        ring = [
            (p["lng"], p["lat"])
            for p in (w.get("geometry") or [])
            if p.get("lat") is not None and p.get("lng") is not None
        ]
        if len(ring) < 2:
            continue
        if len(ring) >= 4 and ring[0] == ring[-1]:
            polys.extend(_clean(Polygon(ring)))          # closed way → polygon
        else:
            fragments.append(LineString(ring))           # fragment → assemble below
    if fragments:
        try:
            for poly in polygonize(unary_union(fragments)):
                polys.extend(_clean(poly))
        except Exception as e:
            logger.warning("water polygonize failed: %s", e)
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
