"""Resolve a SpecV2 studyArea into a shapely polygon (WGS84)."""
from __future__ import annotations

import asyncio
import logging
import math
import re

import httpx
from shapely.geometry import MultiPoint, Point, box

from ..config import get_settings
from ..models.spec import StudyArea

logger = logging.getLogger(__name__)

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
USER_AGENT = "stratageo-engine/1.0.2 (site-suitability analysis)"


def _m_to_deg_lat(m: float) -> float:
    return m / 111_320.0


def _m_to_deg_lng(m: float, lat: float) -> float:
    return m / (111_320.0 * max(0.2, math.cos(math.radians(lat))))


async def geocode(query: str) -> tuple[float, float] | None:
    """Google first (if key present), Nominatim fallback.

    v1.6.4 — country/state-level matches are REJECTED. When a locality string
    can't be matched (e.g. it contained junk the provider choked on), both
    providers happily fall back to a country-level "India" result — whose
    centroid then silently becomes the study area (observed live: a four-
    locality Kolkata brief analyzed near the centroid of India). A locality
    query resolving to a country or state is always wrong; failing honestly
    is better.
    """
    s = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        if s.google_places_api_key:
            try:
                r = await client.get(GOOGLE_GEOCODE_URL, params={
                    "address": query if "india" in query.lower() else f"{query}, India",
                    "key": s.google_places_api_key,
                })
                data = r.json()
                for res in data.get("results", []):
                    types = set(res.get("types") or [])
                    if types & {"country", "administrative_area_level_1"}:
                        logger.warning(
                            "google geocode for %r matched only %s — rejected as too coarse",
                            query, sorted(types),
                        )
                        continue
                    loc = res["geometry"]["location"]
                    return loc["lat"], loc["lng"]
            except Exception as e:
                logger.warning("google geocode failed for %r: %s", query, e)
        try:
            r = await client.get(NOMINATIM_URL, params={
                "q": query if "india" in query.lower() else f"{query}, India",
                "format": "json", "limit": 3, "countrycodes": "in",
            }, headers={"User-Agent": USER_AGENT})
            data = r.json()
            for res in data or []:
                if (res.get("addresstype") or res.get("type")) in ("country", "state"):
                    logger.warning(
                        "nominatim geocode for %r matched only %s — rejected as too coarse",
                        query, res.get("addresstype") or res.get("type"),
                    )
                    continue
                return float(res["lat"]), float(res["lon"])
        except Exception as e:
            logger.warning("nominatim geocode failed for %r: %s", query, e)
    return None


# v1.6.4 — a coordinate pair embedded in a place string, e.g.
#   "Chinar Park[22.624578154074797, 88.43838894071867]"
#   "Salt Lake (22.5888, 88.4121)" / "Sector V @ 22.5777, 88.4335"
# Users who provide exact coordinates mean them literally — they must be used
# directly, never sent to a text geocoder that can't parse them.
_EMBEDDED_COORD_RE = re.compile(
    r"[\[(@\s]\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*[\])]?\s*$"
)


def _plausible_lat(v: float) -> bool:
    """Inhabited-world latitude — rejects polar values that only arise from
    a lat/lng order mix-up (e.g. 88.4 is a longitude in India, never a lat)."""
    return -60.0 <= v <= 72.0


def extract_embedded_coords(name: str) -> tuple[str, tuple[float, float] | None]:
    """Split 'Place[lat, lng]' into ('Place', (lat, lng)); (name, None) if absent.

    Accepts (lat, lng) order; when that reading is implausible (polar
    latitude) but (lng, lat) is plausible, the swap is applied — coordinate
    order is a universally common mix-up.
    """
    m = _EMBEDDED_COORD_RE.search(name or "")
    if not m:
        return (name or "").strip(), None
    a, b = float(m.group(1)), float(m.group(2))
    clean = (name[: m.start()] or "").strip(" -–—@,([")
    as_given_valid = -90.0 <= a <= 90.0 and -180.0 <= b <= 180.0
    swapped_valid = -90.0 <= b <= 90.0 and -180.0 <= a <= 180.0
    if as_given_valid and (_plausible_lat(a) or not swapped_valid):
        return clean or name.strip(), (a, b)
    if swapped_valid and _plausible_lat(b):
        return clean or name.strip(), (b, a)
    if as_given_valid:
        return clean or name.strip(), (a, b)
    return (name or "").strip(), None


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

    # places: use embedded coordinates verbatim where the user provided them;
    # geocode only the (cleaned) names that lack them (Google primary;
    # Nominatim fallback), convex hull, buffer
    places = area.places or []
    parsed = [extract_embedded_coords(name) for name in places]
    to_geocode = [clean for clean, pt in parsed if pt is None]
    geocoded = await asyncio.gather(*(geocode(name) for name in to_geocode))
    geo_iter = iter(geocoded)
    coords: list[tuple[float, float]] = []  # (lng, lat)
    for (clean, embedded) in parsed:
        if embedded is not None:
            lat, lng = embedded
            coords.append((lng, lat))
            notes.append(
                f'Used exact coordinates provided for "{clean}" → {lat:.5f}, {lng:.5f}'
            )
            continue
        pt = next(geo_iter)
        if pt:
            coords.append((pt[1], pt[0]))
            notes.append(f'Geocoded "{clean}" → {pt[0]:.4f}, {pt[1]:.4f}')
        else:
            notes.append(f'Could not geocode "{clean}" — omitted from study area')

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
