"""Resolve a SpecV2 studyArea into a shapely polygon (WGS84)."""
from __future__ import annotations

import asyncio
import logging
import math

import httpx
from shapely.geometry import MultiPoint, Point, box

from ..config import get_settings
from ..models.spec import StudyArea

logger = logging.getLogger(__name__)

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
USER_AGENT = "stratageo-engine/1.0.1 (site-suitability analysis)"


def _m_to_deg_lat(m: float) -> float:
    return m / 111_320.0


def _m_to_deg_lng(m: float, lat: float) -> float:
    return m / (111_320.0 * max(0.2, math.cos(math.radians(lat))))


async def geocode(query: str) -> tuple[float, float] | None:
    """Google first (if key present), Nominatim fallback."""
    s = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        if s.google_places_api_key:
            try:
                r = await client.get(GOOGLE_GEOCODE_URL, params={
                    "address": query if "india" in query.lower() else f"{query}, India",
                    "key": s.google_places_api_key,
                })
                data = r.json()
                if data.get("results"):
                    loc = data["results"][0]["geometry"]["location"]
                    return loc["lat"], loc["lng"]
            except Exception as e:
                logger.warning("google geocode failed for %r: %s", query, e)
        try:
            r = await client.get(NOMINATIM_URL, params={
                "q": query if "india" in query.lower() else f"{query}, India",
                "format": "json", "limit": 1, "countrycodes": "in",
            }, headers={"User-Agent": USER_AGENT})
            data = r.json()
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
        except Exception as e:
            logger.warning("nominatim geocode failed for %r: %s", query, e)
    return None


async def reverse_geocode_name(lat: float, lng: float) -> str | None:
    """Best-effort locality name for a point."""
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.get("https://nominatim.openstreetmap.org/reverse", params={
                "lat": lat, "lon": lng, "format": "json", "zoom": 15,
            }, headers={"User-Agent": USER_AGENT})
            data = r.json()
            addr = data.get("address", {})
            for k in ("neighbourhood", "suburb", "quarter", "residential", "city_district", "town", "village"):
                if addr.get(k):
                    return addr[k]
            return (data.get("display_name") or "").split(",")[0] or None
        except Exception as e:
            logger.warning("reverse geocode failed: %s", e)
            return None


async def resolve_study_area(area: StudyArea) -> tuple[object, list[str]]:
    """Returns (shapely polygon WGS84 lng/lat, notes[])."""
    notes: list[str] = []

    if area.type == "bbox":
        west, south, east, north = area.bbox
        return box(west, south, east, north), notes

    if area.type == "point_radius":
        lat, lng = area.point["lat"], area.point["lng"]
        r = area.radiusM or 3000
        poly = Point(lng, lat).buffer(max(_m_to_deg_lat(r), _m_to_deg_lng(r, lat)))
        return poly, notes

    # places: geocode each, convex hull, buffer
    coords: list[tuple[float, float]] = []  # (lng, lat)
    for name in area.places or []:
        pt = await geocode(name)
        if pt:
            coords.append((pt[1], pt[0]))
            notes.append(f'Geocoded "{name}" → {pt[0]:.4f}, {pt[1]:.4f}')
        else:
            notes.append(f'Could not geocode "{name}" — omitted from study area')
        await asyncio.sleep(0.2)  # be polite to Nominatim

    if not coords:
        raise ValueError("none of the study-area places could be geocoded")

    mean_lat = sum(c[1] for c in coords) / len(coords)
    buffer_deg = max(_m_to_deg_lat(area.hullBufferM), _m_to_deg_lng(area.hullBufferM, mean_lat))
    if len(coords) == 1:
        poly = Point(coords[0]).buffer(max(buffer_deg, _m_to_deg_lat(2000)))
        notes.append("Single place — using 2km minimum buffer")
    else:
        poly = MultiPoint(coords).convex_hull.buffer(buffer_deg)
    return poly, notes
