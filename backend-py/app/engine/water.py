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


def build_sea_polygons(
    coastline_ways: list[dict],
    bbox: tuple[float, float, float, float],
) -> list[Polygon]:
    """v1.11.3 — the OPEN SEA as polygons, derived from `natural=coastline`.

    Live failure: a "high-end gym in South Mumbai" run returned candidate zones
    sitting in the Arabian Sea off Malabar Point. The water mask fetched
    natural=water / waterway=* — which covers rivers, lakes, docks and ponds,
    all mapped as AREAS — but **the ocean is not a polygon in OpenStreetMap**.
    The sea is defined implicitly by `natural=coastline` ways, so a coastal city
    fetched zero water geometry for the sea itself and every offshore hex
    survived the mask.

    OSM's coastline convention is the fix: a coastline way is directed so that
    LAND is on its LEFT and SEA on its RIGHT. We cut the study bbox with the
    merged coastline, then decide each resulting face by probing just off the
    coastline's right-hand side.

    Fail-safe by construction: anything ambiguous (no coastline, degenerate
    geometry, a cut that yields a single face, no face winning a probe) returns
    []. Wrongly masking LAND would delete valid candidates, which is far worse
    than missing some sea — so uncertainty always means "mask nothing".

    `bbox` is (south, west, north, east).
    """
    lines: list[LineString] = []
    for w in coastline_ways:
        pts = [
            (p["lng"], p["lat"])
            for p in (w.get("geometry") or [])
            if p.get("lat") is not None and p.get("lng") is not None
        ]
        if len(pts) >= 2:
            lines.append(LineString(pts))
    if not lines:
        return []

    south, west, north, east = bbox
    if not (north > south and east > west):
        return []
    box = Polygon([(west, south), (east, south), (east, north), (west, north)])

    try:
        merged = unary_union(lines)
        # Faces of the arrangement formed by the bbox edges + the coastline.
        faces = [
            p for p in polygonize(unary_union([box.boundary, merged]))
            if p.is_valid and p.area > 0
        ]
    except Exception as e:
        logger.warning("coastline polygonize failed: %s", e)
        return []
    if len(faces) < 2:
        # Coastline did not actually divide the study area (it may clip a
        # corner, or lie entirely outside). Nothing can be called sea safely.
        return []

    # Probe points a short way off the RIGHT of each coastline segment = sea,
    # and off the LEFT = land. Offset is ~1e-4 deg (≈11 m) — small enough to
    # stay inside the adjacent face, large enough to avoid boundary jitter.
    sea_probes, land_probes = _coastline_probes(lines, step=1e-4)
    if not sea_probes:
        return []

    sea: list[Polygon] = []
    for face in faces:
        n_sea = sum(1 for pt in sea_probes if face.contains(pt))
        n_land = sum(1 for pt in land_probes if face.contains(pt))
        if n_sea > n_land:
            sea.append(face)
    # Every face voting "land", or a tie everywhere, means we could not tell.
    if not sea or len(sea) == len(faces):
        return []
    return sea


def _coastline_probes(
    lines: list[LineString], step: float,
) -> tuple[list[Point], list[Point]]:
    """Sample points just off each side of every coastline segment.

    Right of travel = sea, left = land (OSM convention). Sampling many
    segments rather than one makes the vote robust to a single mis-drawn way.
    """
    sea: list[Point] = []
    land: list[Point] = []
    for line in lines:
        coords = list(line.coords)
        for a, b in zip(coords, coords[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = (dx * dx + dy * dy) ** 0.5
            if length == 0:
                continue
            mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
            # Unit normal; (dy, -dx) points to the RIGHT of travel.
            nx, ny = dy / length, -dx / length
            sea.append(Point(mx + nx * step, my + ny * step))
            land.append(Point(mx - nx * step, my - ny * step))
    return sea, land


def sea_overlap_mask(
    hexes: list[HexCell],
    coastline_ways: list[dict],
    boundaries: list,
    bbox: tuple[float, float, float, float],
    ratio: float = 0.30,
) -> np.ndarray:
    """v1.11.3 — mask hexes more than `ratio` of whose AREA is open sea.

    Mirrors water_overlap_mask, but over coastline-derived sea polygons rather
    than tagged water areas. Same threshold, so a shoreline hex that is mostly
    land still qualifies — only genuinely offshore cells are removed.
    """
    mask = np.zeros(len(hexes), dtype=bool)
    sea = build_sea_polygons(coastline_ways, bbox)
    if not sea or not boundaries:
        return mask
    merged = unary_union(sea)
    for i in range(len(hexes)):
        ring = boundaries[i] if i < len(boundaries) else None
        if not ring or len(ring) < 3:
            continue
        try:
            hexpoly = Polygon([(lng, lat) for lat, lng in ring])  # boundary is [lat,lng]
            if hexpoly.area <= 0:
                continue
            inter = hexpoly.intersection(merged)
            if not inter.is_empty and (inter.area / hexpoly.area) > ratio:
                mask[i] = True
        except Exception:
            continue
    return mask


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


def water_overlap_mask(
    hexes: list[HexCell], ways: list[dict], boundaries: list, ratio: float = 0.30
) -> np.ndarray:
    """Spatial Reliability Upgrade v1.0.3 — area-overlap water mask.

    The centroid test (water_mask) keeps a hex that is e.g. 45% river as long as its
    CENTRE is on the bank. This catches those: a hex is masked when more than `ratio`
    of its AREA is water. `boundaries[i]` is the hex ring as [[lat,lng],...] (from
    grid.cell_boundary); we build the hex polygon in lng/lat to match the water polys.
    Returns a mask to be OR-ed with the centroid mask (both are hard exclusions).
    """
    mask = np.zeros(len(hexes), dtype=bool)
    polys = build_water_polygons(ways)
    if not polys or not boundaries:
        return mask
    merged = unary_union(polys)
    for i in range(len(hexes)):
        ring = boundaries[i] if i < len(boundaries) else None
        if not ring or len(ring) < 3:
            continue
        try:
            hexpoly = Polygon([(lng, lat) for lat, lng in ring])  # boundary is [lat,lng]
            if hexpoly.area <= 0:
                continue
            inter = hexpoly.intersection(merged)
            if not inter.is_empty and (inter.area / hexpoly.area) > ratio:
                mask[i] = True
        except Exception:
            continue
    return mask
