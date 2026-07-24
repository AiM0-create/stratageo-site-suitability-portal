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


# v1.8.1 — minimum study-area extent floor. The type="places" path already
# enforces a 2 km minimum buffer (below), but type="point_radius" and
# type="bbox" used the LLM's value VERBATIM with no floor. A "specific
# intersections or blocks" brief makes the model pick a tiny area, and when
# the deterministic planner then bumps the grid to res 10 (block granularity),
# polyfill produced ~1 hex — a single mask then removed it and the run
# reported a false "no viable site" (observed live on the JP Nagar 2nd Phase
# grocery prompt). 1.5 km radius still keeps a block-level analysis local
# (~450 res-10 cells) while guaranteeing a usable grid.
MIN_STUDY_AREA_RADIUS_M = 1500.0


async def geocode_with_bbox(
    query: str,
) -> tuple[float, float, tuple[float, float, float, float] | None] | None:
    """Like geocode(), but also returns the provider's extent for the place:
    (lat, lng, (south, west, north, east) | None).

    v1.6.8 — needed because a single-place study area was previously a point
    + 2 km minimum buffer, which turned "Pune" (a ~25 km-wide city) into 17
    hexes around its centroid. The geocoder KNOWS the extent; use it.
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
                        continue
                    geom = res.get("geometry") or {}
                    loc = geom["location"]
                    box = geom.get("bounds") or geom.get("viewport")
                    bbox = None
                    if box and box.get("southwest") and box.get("northeast"):
                        bbox = (
                            float(box["southwest"]["lat"]), float(box["southwest"]["lng"]),
                            float(box["northeast"]["lat"]), float(box["northeast"]["lng"]),
                        )
                    return loc["lat"], loc["lng"], bbox
            except Exception as e:
                logger.warning("google geocode(bbox) failed for %r: %s", query, e)
        try:
            r = await client.get(NOMINATIM_URL, params={
                "q": query if "india" in query.lower() else f"{query}, India",
                "format": "json", "limit": 3, "countrycodes": "in",
            }, headers={"User-Agent": USER_AGENT})
            data = r.json()
            for res in data or []:
                if (res.get("addresstype") or res.get("type")) in ("country", "state"):
                    continue
                bb = res.get("boundingbox")
                bbox = None
                if bb and len(bb) == 4:
                    # Nominatim order: [south, north, west, east]
                    bbox = (float(bb[0]), float(bb[2]), float(bb[1]), float(bb[3]))
                return float(res["lat"]), float(res["lon"]), bbox
        except Exception as e:
            logger.warning("nominatim geocode(bbox) failed for %r: %s", query, e)
    return None


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
        # v1.8.1 — floor a degenerate/tiny bbox to a minimum extent around its
        # centre so res-10 polyfill can't collapse to ~1 hex (see
        # MIN_STUDY_AREA_RADIUS_M). Legitimately larger bboxes pass through.
        clat = (south + north) / 2.0
        min_half_lat = _m_to_deg_lat(MIN_STUDY_AREA_RADIUS_M)
        min_half_lng = _m_to_deg_lng(MIN_STUDY_AREA_RADIUS_M, clat)
        clng = (west + east) / 2.0
        half_lat = max((north - south) / 2.0, min_half_lat)
        half_lng = max((east - west) / 2.0, min_half_lng)
        if half_lat > (north - south) / 2.0 or half_lng > (east - west) / 2.0:
            notes.append(
                "Study-area bounding box was smaller than the minimum viable "
                f"screening extent — expanded to ~{2 * MIN_STUDY_AREA_RADIUS_M / 1000:.1f} km "
                "around its centre so the grid isn't degenerate."
            )
        return box(clng - half_lng, clat - half_lat, clng + half_lng, clat + half_lat), notes

    if area.type == "point_radius":
        lat, lng = area.point["lat"], area.point["lng"]
        # v1.8.1 — floor the radius so a tiny LLM-chosen radius (a "specific
        # blocks" brief) can't produce a ~1-hex grid at res 10.
        r = max(area.radiusM or 3000, MIN_STUDY_AREA_RADIUS_M)
        if r > (area.radiusM or 3000):
            notes.append(
                f"Study-area radius floored to {r / 1000:.1f} km (minimum viable "
                "screening extent) so the grid isn't degenerate."
            )
        poly = Point(lng, lat).buffer(max(_m_to_deg_lat(r), _m_to_deg_lng(r, lat)))
        return poly, notes

    places = area.places or []
    parsed = [extract_embedded_coords(name) for name in places]

    # v1.6.8 — single NAMED place (no embedded coordinates): use the
    # geocoder's actual extent. "Pune" previously became its centroid + a
    # 2 km minimum buffer — 17 hexes of a ~25 km city (user-reported). Extent
    # sanity window: 1.5–60 km diagonal (below → keep the point buffer, a
    # street address doesn't need a bbox; above → likely a district/region
    # match, too coarse to trust). polyfill() still auto-degrades resolution
    # if a metro-scale bbox would explode the hex budget.
    if len(parsed) == 1 and parsed[0][1] is None:
        clean = parsed[0][0]
        g = await geocode_with_bbox(clean)
        if g:
            lat, lng, bbox = g
            if bbox:
                s_, w_, n_, e_ = bbox
                diag_km = math.hypot((n_ - s_) * 111.32,
                                     (e_ - w_) * 111.32 * math.cos(math.radians(lat)))
                if 1.5 <= diag_km <= 60.0:
                    notes.append(
                        f'Geocoded "{clean}" → {lat:.4f}, {lng:.4f}; using its full '
                        f"mapped extent (~{diag_km:.0f} km across) as the study area "
                        "instead of a 2 km point buffer."
                    )
                    return box(w_, s_, e_, n_), notes
            buffer_deg = max(_m_to_deg_lat(area.hullBufferM),
                             _m_to_deg_lng(area.hullBufferM, lat))
            notes.append(f'Geocoded "{clean}" → {lat:.4f}, {lng:.4f}')
            notes.append("Single place — using 2km minimum buffer")
            return Point(lng, lat).buffer(max(buffer_deg, _m_to_deg_lat(2000))), notes
        notes.append(f'Could not geocode "{clean}" — omitted from study area')
        raise ValueError("none of the study-area places could be geocoded")

    # places with embedded coordinates and/or multiple names: use coordinates
    # verbatim where provided; geocode only the (cleaned) names that lack them
    # (Google primary; Nominatim fallback), convex hull, buffer
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
