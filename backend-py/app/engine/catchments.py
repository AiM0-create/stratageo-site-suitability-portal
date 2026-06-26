"""Isochrone-based Pass-B catchment refinement — v1.4.0.

Primary: Google Maps Routes API (computeRouteMatrix) to check reachability of
         surrounding sample points, then build a convex-hull polygon.
Fallback: OpenRouteService (ORS) polygon isochrones (requires ors_api_key).
Final fallback: Euclidean proxy (Pass-A value, no refinement).

On any failure the caller keeps the Pass-A proxy value (graceful degradation).
"""
from __future__ import annotations

import asyncio
import logging
import math
import time

import httpx
from shapely.geometry import MultiPoint, Point, shape
from shapely.ops import unary_union

from ..config import get_settings
from .grid import HexCell

logger = logging.getLogger(__name__)

# ── ORS (fallback) ────────────────────────────────────────────────────────────
ORS_URL = "https://api.openrouteservice.org/v2/isochrones"
ORS_PROFILE = {"walk": "foot-walking", "drive": "driving-car"}

# ── Google Routes API (primary) ───────────────────────────────────────────────
GOOGLE_ROUTE_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
GOOGLE_FIELD_MASK = "originIndex,destinationIndex,duration,condition"

# Sampling grid for building approximate isochrone polygons
# Walk: 16 points at 3 radii; Drive: 24 points at 4 radii → good polygon shape
_SAMPLE_BEARINGS_16 = [i * 22.5 for i in range(16)]
_SAMPLE_BEARINGS_24 = [i * 15.0 for i in range(24)]

EARTH_R = 6_371_000.0  # metres

_iso_cache: dict[tuple, object] = {}   # (h3_id, mode, minutes) → shapely polygon
_last_ors_ts: list[float] = []         # naive 20/min rate limiter for ORS


async def _rate_limit():
    """Backward-compatible alias — reuses ORS token bucket (used by routing.py)."""
    import time as _time
    now = _time.time()
    import asyncio as _asyncio
    while len(_last_ors_ts) >= 18 and now - _last_ors_ts[0] < 60:
        await _asyncio.sleep(2)
        now = _time.time()
    while _last_ors_ts and now - _last_ors_ts[0] > 60:
        _last_ors_ts.pop(0)
    _last_ors_ts.append(now)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _offset_point(lat: float, lng: float, bearing_deg: float, dist_m: float):
    """Return (lat, lng) at `dist_m` metres from origin in `bearing_deg` direction."""
    b = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lng1 = math.radians(lng)
    d_r = dist_m / EARTH_R
    lat2 = math.asin(math.sin(lat1) * math.cos(d_r)
                     + math.cos(lat1) * math.sin(d_r) * math.cos(b))
    lng2 = lng1 + math.atan2(math.sin(b) * math.sin(d_r) * math.cos(lat1),
                              math.cos(d_r) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lng2)


def _build_sample_grid(lat: float, lng: float, mode: str, minutes: int) -> list[tuple]:
    """Return a list of (lat, lng) sample points for isochrone polygon building.

    Walk: ~80 m/min → 16 bearings × 3 radii at 33%/66%/100% of max distance.
    Drive: ~400 m/min → 24 bearings × 4 radii.
    """
    s = get_settings()
    if mode == "walk":
        max_m = minutes * s.walk_speed_m_per_min
        bearings = _SAMPLE_BEARINGS_16
        radii = [0.33, 0.66, 1.0]
    else:
        max_m = minutes * s.drive_speed_m_per_min
        bearings = _SAMPLE_BEARINGS_24
        radii = [0.25, 0.50, 0.75, 1.0]
    pts = []
    for r in radii:
        dist = max_m * r
        for b in bearings:
            pts.append(_offset_point(lat, lng, b, dist))
    return pts


async def _google_isochrone(
    client: httpx.AsyncClient,
    cell: HexCell,
    mode: str,
    minutes: int,
    api_key: str,
) -> object | None:
    """Build an approximate isochrone polygon using Google Routes computeRouteMatrix.

    Sends one origin → N sample destinations, keeps reachable ones, returns
    convex hull polygon. Returns None on any error (caller uses ORS fallback).
    """
    sample_pts = _build_sample_grid(cell.lat, cell.lng, mode, minutes)
    travel_mode = "WALK" if mode == "walk" else "DRIVE"
    max_seconds = minutes * 60

    body = {
        "origins": [{"waypoint": {"location": {"latLng": {"latitude": cell.lat, "longitude": cell.lng}}}}],
        "destinations": [
            {"waypoint": {"location": {"latLng": {"latitude": lat, "longitude": lng}}}}
            for lat, lng in sample_pts
        ],
        "travelMode": travel_mode,
        "routingPreference": "TRAFFIC_UNAWARE",
    }
    try:
        r = await client.post(
            GOOGLE_ROUTE_MATRIX_URL,
            json=body,
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
            },
        )
        r.raise_for_status()
        rows = r.json() if isinstance(r.json(), list) else []

        reachable_pts = [Point(sample_pts[row["destinationIndex"]][1],
                               sample_pts[row["destinationIndex"]][0])
                         for row in rows
                         if row.get("condition") == "ROUTE_EXISTS"
                         and _parse_duration(row.get("duration", "")) <= max_seconds]

        if len(reachable_pts) < 4:
            return None
        # Convex hull of reachable sample points → approximate isochrone polygon
        hull = MultiPoint(reachable_pts).convex_hull
        return hull if hull.is_valid and not hull.is_empty else None
    except Exception as e:
        logger.debug("Google isochrone failed for %s (%s %dmin): %s", cell.h3_id, mode, minutes, e)
        return None


def _parse_duration(s: str) -> float:
    """Parse '300s' → 300.0 (seconds). Returns inf on failure."""
    try:
        return float(s.rstrip("s"))
    except (ValueError, AttributeError):
        return float("inf")


async def _ors_rate_limit():
    now = time.time()
    while len(_last_ors_ts) >= 18 and now - _last_ors_ts[0] < 60:
        await asyncio.sleep(2)
        now = time.time()
    while _last_ors_ts and now - _last_ors_ts[0] > 60:
        _last_ors_ts.pop(0)
    _last_ors_ts.append(now)


async def _ors_isochrone_batch(
    client: httpx.AsyncClient,
    batch: list[HexCell],
    mode: str,
    minutes: int,
    ors_key: str,
    out: dict,
) -> None:
    """Fetch ORS isochrones for a batch of cells (fallback path)."""
    await _ors_rate_limit()
    try:
        r = await client.post(
            f"{ORS_URL}/{ORS_PROFILE[mode]}",
            json={
                "locations": [[c.lng, c.lat] for c in batch],
                "range": [minutes * 60],
                "range_type": "time",
            },
            headers={"Authorization": ors_key},
        )
        r.raise_for_status()
        data = r.json()
        from ..services import storage
        from shapely.geometry import mapping as shp_mapping
        for feat in data.get("features", []):
            gi = feat.get("properties", {}).get("group_index", 0)
            if gi < len(batch):
                poly = shape(feat["geometry"])
                cell = batch[gi]
                _iso_cache[(cell.h3_id, mode, minutes)] = poly
                out[cell.h3_id] = poly
                if storage.enabled():
                    await storage.put_json(
                        f"iso/{cell.h3_id}_{mode}_{minutes}.json", shp_mapping(poly),
                    )
    except Exception as e:
        logger.warning("ORS isochrone batch failed (%s %dmin): %s", mode, minutes, e)


async def fetch_isochrones(
    cells: list[HexCell],
    mode: str,
    minutes: int,
) -> dict[str, object]:
    """Return {h3_id: shapely polygon} for cells we could compute. Missing = failed.

    v1.4.0 priority order:
      1. In-memory cache hit
      2. GCS persistent cache hit
      3. Google Routes API (primary — uses google_places_api_key)
      4. ORS (fallback — uses ors_api_key)
    """
    s = get_settings()
    out: dict[str, object] = {}
    todo: list[HexCell] = []

    # 1. Memory cache
    for c in cells:
        key = (c.h3_id, mode, minutes)
        if key in _iso_cache:
            out[c.h3_id] = _iso_cache[key]
        else:
            todo.append(c)

    # 2. GCS persistent cache
    from ..services import storage
    if storage.enabled() and todo:
        from shapely.geometry import shape as shp
        still_todo: list[HexCell] = []
        for c in todo:
            cached = await storage.get_json(f"iso/{c.h3_id}_{mode}_{minutes}.json")
            if cached is not None:
                try:
                    poly = shp(cached)
                    _iso_cache[(c.h3_id, mode, minutes)] = poly
                    out[c.h3_id] = poly
                    continue
                except Exception:
                    pass
            still_todo.append(c)
        todo = still_todo

    if not todo:
        return out

    use_google = bool(s.google_places_api_key)
    use_ors = bool(s.ors_api_key)

    if not use_google and not use_ors:
        logger.warning("No isochrone API key (google_places or ors) — skipping refinement")
        return out

    # 3 + 4. Try Google first, fall back to ORS per cell
    async with httpx.AsyncClient(timeout=30) as client:
        ors_needed: list[HexCell] = []
        google_tasks = []

        if use_google:
            google_tasks = [
                _google_isochrone(client, c, mode, minutes, s.google_places_api_key)
                for c in todo
            ]
            results = await asyncio.gather(*google_tasks, return_exceptions=True)
            for c, poly in zip(todo, results):
                if isinstance(poly, Exception) or poly is None:
                    if use_ors:
                        ors_needed.append(c)
                    # else: stays missing → caller keeps Euclidean proxy
                else:
                    _iso_cache[(c.h3_id, mode, minutes)] = poly
                    out[c.h3_id] = poly
                    if storage.enabled():
                        from shapely.geometry import mapping as shp_mapping
                        await storage.put_json(
                            f"iso/{c.h3_id}_{mode}_{minutes}.json", shp_mapping(poly),
                        )
            logger.info(
                "Google isochrones: %d/%d succeeded (%s %dmin); %d falling back to ORS",
                len(todo) - len(ors_needed), len(todo), mode, minutes, len(ors_needed),
            )
        else:
            ors_needed = todo

        # ORS fallback for cells where Google failed or key unavailable
        if ors_needed and use_ors:
            batch_size = s.ors_batch_size
            batches = [ors_needed[i: i + batch_size] for i in range(0, len(ors_needed), batch_size)]
            await asyncio.gather(*(
                _ors_isochrone_batch(client, b, mode, minutes, s.ors_api_key, out)
                for b in batches
            ))

    return out


def count_pois_in_polygon(polygon, pois: list[dict]) -> int:
    return sum(1 for p in pois if polygon.contains(Point(p["lng"], p["lat"])))
