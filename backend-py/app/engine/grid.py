"""H3 hex grid over the study area polygon (h3-py v4 API)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

import h3
from shapely.geometry import mapping

from ..config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class HexCell:
    h3_id: str
    lat: float
    lng: float


def polyfill(polygon, resolution: int) -> tuple[list[HexCell], int, list[str]]:
    """Fill polygon with H3 cells. Auto-degrades resolution if hex count explodes.
    Returns (cells, effective_resolution, notes)."""
    s = get_settings()
    notes: list[str] = []
    res = resolution

    geo = mapping(polygon)  # GeoJSON dict, lng/lat order
    while True:
        try:
            shape = h3.geo_to_h3shape(geo)
            ids = h3.h3shape_to_cells(shape, res)
        except Exception as e:
            raise ValueError(f"H3 polyfill failed: {e}") from e
        if len(ids) <= s.max_hexes or res <= 7:
            break
        notes.append(f"Study area produced {len(ids)} hexes at res {res} — degrading to res {res - 1}")
        res -= 1

    cells = []
    for hid in ids:
        lat, lng = h3.cell_to_latlng(hid)
        cells.append(HexCell(h3_id=hid, lat=lat, lng=lng))
    logger.info("Grid: %d hexes at res %d", len(cells), res)
    if not cells:
        raise ValueError("study area polygon produced zero hexes")
    return cells, res, notes


def hex_distance_rings(a: str, b: str) -> int:
    """Grid distance in rings between two cells (same resolution)."""
    try:
        return h3.grid_distance(a, b)
    except Exception:
        return 999
