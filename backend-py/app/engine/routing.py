"""Barrier-aware network routing (v1.0.1.6).

Real ORS Directions routing for the top-K candidates — door-to-door walk/drive
distance + time along the network, optional barrier avoidance (route around
railway corridors), and railway-crossing detection on the resulting path.

Cost control: only the top-K candidates are routed (Pass B), each route is
cached in GCS, and the ORS calls share the isochrone rate-limiter.
"""
from __future__ import annotations

import asyncio
import logging

import httpx
from shapely.geometry import LineString, mapping, shape
from shapely.ops import unary_union

from ..config import get_settings
from ..services import storage
from .catchments import _rate_limit  # reuse the ORS token bucket
from .data_osm import OVERPASS_ENDPOINTS, USER_AGENT, HTTP_TIMEOUT

logger = logging.getLogger(__name__)

ORS_DIRECTIONS = "https://api.openrouteservice.org/v2/directions/{profile}/geojson"
ORS_PROFILE = {"walk": "foot-walking", "drive": "driving-car"}
RAILWAY_BUFFER_M = 12.0   # half-width of the avoid corridor built around each track


# ── Railway geometry (LineStrings, not centroids) ──────────────────────────────

async def fetch_railway_lines(bbox: tuple[float, float, float, float]) -> list:
    """Railway track centrelines as shapely LineStrings within bbox (s,w,n,e).
    Uses Overpass `out geom` (full geometry) — the POI fetch only has centroids.
    Cached in GCS so repeat analyses of the same area skip the fetch."""
    s, w, n, e = bbox
    gcs_key = f"railway/{storage.cache_key((round(s,3), round(w,3), round(n,3), round(e,3)))}.json"
    if storage.enabled():
        cached = await storage.get_json(gcs_key)
        if cached is not None:
            return [LineString(c) for c in cached if len(c) >= 2]

    query = (
        f"[out:json][timeout:60];"
        f'(way["railway"~"rail|light_rail|subway|tram|monorail"]({s},{w},{n},{e}););'
        f"out geom;"
    )
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
                r = await client.post(endpoint, data={"data": query})
                r.raise_for_status()
                data = r.json()
            lines, raw = [], []
            for el in data.get("elements", []):
                geom = el.get("geometry") or []
                pts = [(p["lon"], p["lat"]) for p in geom if "lon" in p and "lat" in p]
                if len(pts) >= 2:
                    lines.append(LineString(pts))
                    raw.append(pts)
            if storage.enabled():
                await storage.put_json(gcs_key, raw)
            logger.info("Railway geometry: %d track segments in bbox", len(lines))
            return lines
        except Exception as ex:
            logger.warning("Railway fetch failed (%s): %s", endpoint, ex)
            await asyncio.sleep(1)
    logger.warning("Railway geometry unavailable — barrier avoidance/crossing checks will be 'unavailable'")
    return []


def _m_to_deg(m: float, lat: float) -> float:
    import math
    return m / (111_320.0 * max(0.2, math.cos(math.radians(lat))))


def build_avoid_polygons(railway_lines: list, near_lat: float) -> dict | None:
    """Buffer the railway lines into thin corridors → a (Multi)Polygon GeoJSON
    suitable for ORS `avoid_polygons`. None if there are no tracks."""
    if not railway_lines:
        return None
    buf = _m_to_deg(RAILWAY_BUFFER_M, near_lat)
    polys = [ln.buffer(buf) for ln in railway_lines]
    merged = unary_union(polys)
    return mapping(merged)


def crosses_railway(route_line: LineString, railway_lines: list) -> bool:
    """Does the route path intersect any railway track centreline?"""
    return any(route_line.intersects(ln) for ln in railway_lines)


# ── ORS routing ────────────────────────────────────────────────────────────────

async def route(
    origin: tuple[float, float],         # (lat, lng)
    dest: tuple[float, float],           # (lat, lng)
    mode: str,
    avoid_geojson: dict | None = None,
    cache_tag: str = "",
) -> dict | None:
    """ORS Directions → {distanceM, durationMin, geometry: LineString} or None.
    Cached in GCS by (origin, dest, mode, avoid_tag)."""
    s = get_settings()
    if not s.ors_api_key:
        return None

    key = f"route/{storage.cache_key((round(origin[0],5), round(origin[1],5), round(dest[0],5), round(dest[1],5), mode, cache_tag))}.json"
    if storage.enabled():
        cached = await storage.get_json(key)
        if cached is not None:
            return {**cached, "geometry": LineString(cached["geomCoords"])} if cached.get("geomCoords") else None

    body: dict = {"coordinates": [[origin[1], origin[0]], [dest[1], dest[0]]]}
    if avoid_geojson:
        body["options"] = {"avoid_polygons": avoid_geojson}

    await _rate_limit()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                ORS_DIRECTIONS.format(profile=ORS_PROFILE[mode]),
                json=body,
                headers={"Authorization": s.ors_api_key, "Content-Type": "application/json"},
            )
            r.raise_for_status()
            data = r.json()
        feat = (data.get("features") or [None])[0]
        if not feat:
            return None
        summ = feat["properties"]["summary"]
        coords = feat["geometry"]["coordinates"]   # [lng,lat] pairs
        result = {
            "distanceM": round(summ["distance"], 1),
            "durationMin": round(summ["duration"] / 60.0, 1),
            "geomCoords": coords,
        }
        if storage.enabled():
            await storage.put_json(key, result)
        return {**result, "geometry": LineString(coords)}
    except Exception as ex:
        # avoid_polygons with no possible route → ORS 2010; treat as "no route"
        logger.warning("ORS route failed (%s %s→%s): %s", mode, origin, dest, ex)
        return None


# ── Per-candidate constraint evaluation ────────────────────────────────────────

def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    import math
    (lat1, lng1), (lat2, lng2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000.0 * math.asin(math.sqrt(h))


async def evaluate_route_constraint(
    constraint,                                   # RouteConstraint
    candidates: list,                             # list[HexCell] (top-K)
    target_points: list[tuple[float, float]],     # resolved destinations (lat,lng)
    railway_lines: list,
) -> dict[int, dict]:
    """For each candidate index → metrics dict:
       {target, straightLineM, networkM, travelMin, crossesRailway, passed, status}
    status: 'evaluated' | 'unavailable' (routing/target missing)."""
    out: dict[int, dict] = {}
    if not target_points:
        for i in range(len(candidates)):
            out[i] = {"status": "unavailable", "reason": "destination could not be resolved",
                      "passed": None, "crossesRailway": None, "networkM": None, "travelMin": None}
        return out

    # Route the NATURAL shortest path, then test whether it crosses a railway.
    # (avoid_polygons would route AROUND tracks and could report "no route" for a
    # genuinely reachable site — natural-route + crossing-test answers the user's
    # "without crossing railway" question directly and truthfully.)
    async def one(i: int, cell):
        origin = (cell.lat, cell.lng)
        # nearest target by straight line
        dest = min(target_points, key=lambda t: _haversine_m(origin, t))
        straight = _haversine_m(origin, dest)
        r = await route(origin, dest, constraint.mode, avoid_geojson=None, cache_tag="")
        if r is None:
            out[i] = {"status": "unavailable", "reason": "no route returned (routing service or blocked path)",
                      "target": dest, "straightLineM": round(straight, 1),
                      "passed": None, "crossesRailway": None, "networkM": None, "travelMin": None}
            return
        crosses = crosses_railway(r["geometry"], railway_lines) if railway_lines else None
        passed = True
        reasons = []
        if constraint.maxDistanceM is not None and r["distanceM"] > constraint.maxDistanceM:
            passed = False; reasons.append(f"{r['distanceM']:.0f}m > {constraint.maxDistanceM:.0f}m")
        if constraint.maxMinutes is not None and r["durationMin"] > constraint.maxMinutes:
            passed = False; reasons.append(f"{r['durationMin']:.1f}min > {constraint.maxMinutes:.0f}min")
        if constraint.avoidRailwayCrossing and crosses:
            passed = False; reasons.append("route crosses railway")
        out[i] = {
            "status": "evaluated",
            "target": dest,
            "straightLineM": round(straight, 1),
            "networkM": r["distanceM"],
            "travelMin": r["durationMin"],
            "crossesRailway": crosses,
            "passed": passed,
            "reason": "; ".join(reasons) if reasons else "all conditions met",
        }

    await asyncio.gather(*(one(i, c) for i, c in enumerate(candidates)))
    return out

