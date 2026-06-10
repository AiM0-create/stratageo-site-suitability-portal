"""Google Places POI fetch for google_places layers.

Sample-point grid over the study bbox (spacing ≈ 2×probe radius), Nearby Search
per point per type, dedupe by place_id. Bounded: ≤3 places layers per spec,
≤25 sample points, ≤2 pagination pages.
"""
from __future__ import annotations

import asyncio
import logging
import math

import httpx

from ..config import get_settings

logger = logging.getLogger(__name__)

NEARBY_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
PROBE_RADIUS_M = 1500
MAX_SAMPLE_POINTS = 25
MAX_PAGES = 2


def _sample_points(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    """bbox = (south, west, north, east) → [(lat, lng)] grid."""
    s, w, n, e = bbox
    lat_step = (2 * PROBE_RADIUS_M) / 111_320.0
    mid_lat = (s + n) / 2
    lng_step = (2 * PROBE_RADIUS_M) / (111_320.0 * max(0.2, math.cos(math.radians(mid_lat))))
    pts = []
    lat = s + lat_step / 2
    while lat < n:
        lng = w + lng_step / 2
        while lng < e:
            pts.append((lat, lng))
            lng += lng_step
        lat += lat_step
    if len(pts) > MAX_SAMPLE_POINTS:
        # thin evenly
        step = len(pts) / MAX_SAMPLE_POINTS
        pts = [pts[int(i * step)] for i in range(MAX_SAMPLE_POINTS)]
    return pts


async def fetch_places_pois(
    types: list[str],
    keyword: str | None,
    bbox: tuple[float, float, float, float],
) -> list[dict]:
    s = get_settings()
    if not s.google_places_api_key:
        logger.warning("No GOOGLE_PLACES_API_KEY — google_places layer returns no data")
        return []

    seen: dict[str, dict] = {}
    points = _sample_points(bbox)
    ptype = types[0] if types else None

    async with httpx.AsyncClient(timeout=30) as client:
        for lat, lng in points:
            params = {
                "location": f"{lat},{lng}",
                "radius": PROBE_RADIUS_M,
                "key": s.google_places_api_key,
            }
            if ptype:
                params["type"] = ptype
            if keyword:
                params["keyword"] = keyword
            token = None
            for _page in range(MAX_PAGES):
                if token:
                    params_page = {"pagetoken": token, "key": s.google_places_api_key}
                    await asyncio.sleep(2)  # token activation delay
                else:
                    params_page = params
                try:
                    r = await client.get(NEARBY_URL, params=params_page)
                    data = r.json()
                except Exception as e:
                    logger.warning("Places fetch failed @%s,%s: %s", lat, lng, e)
                    break
                for res in data.get("results", []):
                    pid = res.get("place_id")
                    loc = res.get("geometry", {}).get("location", {})
                    if pid and pid not in seen and loc:
                        seen[pid] = {
                            "lat": loc["lat"],
                            "lng": loc["lng"],
                            "tags": {"name": res.get("name", ""), "google_type": ptype or keyword or ""},
                        }
                token = data.get("next_page_token")
                if not token:
                    break

    logger.info("Places: %d unique POIs for types=%s", len(seen), types)
    return list(seen.values())
