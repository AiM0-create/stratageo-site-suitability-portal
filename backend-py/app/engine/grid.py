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


def polyfill(polygon, resolution: int, min_cells: int = 0) -> tuple[list[HexCell], int, list[str]]:
    """Fill polygon with H3 cells. Auto-degrades resolution if hex count explodes;
    auto-REFINES it (v1.10.0) when the grid is too small to rank meaningfully.
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

    # v1.10.0 — upward adaptation. A small locality at a coarse archetype
    # default produced grids too small to rank (observed live: Sector V
    # supermarket → 6 cells at res 8, 2 eligible, top-3 requested — and a
    # 6-value percentile stretch produced nonsense scores like "0.0/10
    # despite 439 observed"). Below `min_cells`, refine one level at a time
    # (each level ≈ 7× more cells) up to res 10, with a disclosed note.
    # Cannot conflict with the degrade loop above: <min_cells and >max_hexes
    # are mutually exclusive, and from <min_cells the refined count is
    # bounded ≈ min_cells × 7^levels ≪ max_hexes.
    while min_cells > 0 and len(ids) < min_cells and res < 10:
        res += 1
        try:
            ids = h3.h3shape_to_cells(h3.geo_to_h3shape(geo), res)
        except Exception as e:
            raise ValueError(f"H3 polyfill failed: {e}") from e
        notes.append(
            f"Study area is small — grid refined to H3 level {res} "
            f"({len(ids)} cells) so zones can be meaningfully compared and ranked."
        )

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


def cell_boundary(h3_id: str) -> list[list[float]]:
    """Hex boundary as [[lat, lng], ...] (closed ring not required by Leaflet)."""
    return [[round(lat, 5), round(lng, 5)] for lat, lng in h3.cell_to_boundary(h3_id)]
