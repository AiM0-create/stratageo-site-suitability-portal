"""OpenRouteService isochrones for Pass-B refinement.

Free tier: ~500 isochrone requests/day, 20/min. We batch up to 5 locations per
request and cache by (h3_id, mode, minutes). On any failure the caller keeps
the Pass-A proxy value (graceful degradation, surfaced as a warning).
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx
from shapely.geometry import Point, shape

from ..config import get_settings
from .grid import HexCell

logger = logging.getLogger(__name__)

ORS_URL = "https://api.openrouteservice.org/v2/isochrones"
ORS_PROFILE = {"walk": "foot-walking", "drive": "driving-car"}

_iso_cache: dict[tuple, object] = {}   # (h3_id, mode, minutes) → shapely polygon
_last_request_ts: list[float] = []     # naive 20/min limiter


async def _rate_limit():
    now = time.time()
    while len(_last_request_ts) >= 18 and now - _last_request_ts[0] < 60:
        await asyncio.sleep(2)
        now = time.time()
    while _last_request_ts and now - _last_request_ts[0] > 60:
        _last_request_ts.pop(0)
    _last_request_ts.append(now)


async def fetch_isochrones(
    cells: list[HexCell],
    mode: str,
    minutes: int,
) -> dict[str, object]:
    """Returns {h3_id: shapely polygon} for cells we could compute. Missing = failed."""
    s = get_settings()
    if not s.ors_api_key:
        logger.warning("No ORS_API_KEY — skipping isochrone refinement")
        return {}

    out: dict[str, object] = {}
    todo = []
    for c in cells:
        key = (c.h3_id, mode, minutes)
        if key in _iso_cache:
            out[c.h3_id] = _iso_cache[key]
        else:
            todo.append(c)

    batch_size = s.ors_batch_size
    async with httpx.AsyncClient(timeout=60) as client:
        for i in range(0, len(todo), batch_size):
            batch = todo[i : i + batch_size]
            await _rate_limit()
            try:
                r = await client.post(
                    f"{ORS_URL}/{ORS_PROFILE[mode]}",
                    json={
                        "locations": [[c.lng, c.lat] for c in batch],
                        "range": [minutes * 60],
                        "range_type": "time",
                    },
                    headers={"Authorization": s.ors_api_key},
                )
                r.raise_for_status()
                data = r.json()
                feats = data.get("features", [])
                # ORS returns one feature per location, group_index ties them back
                for feat in feats:
                    gi = feat.get("properties", {}).get("group_index", 0)
                    if gi < len(batch):
                        poly = shape(feat["geometry"])
                        cell = batch[gi]
                        _iso_cache[(cell.h3_id, mode, minutes)] = poly
                        out[cell.h3_id] = poly
            except Exception as e:
                logger.warning("ORS isochrone batch failed (%s %dmin): %s", mode, minutes, e)
                # keep going — remaining batches may still succeed
    return out


def count_pois_in_polygon(polygon, pois: list[dict]) -> int:
    return sum(1 for p in pois if polygon.contains(Point(p["lng"], p["lat"])))
