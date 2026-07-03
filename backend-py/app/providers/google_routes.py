"""Google Routes API — route validation for top candidates (v1.4.8).

Primary provider for route-constraint validation (drive/walk time + distance
+ path geometry for railway-crossing checks); ORS Directions remains the
fallback (see engine/routing.py). If neither works, the constraint is marked
unavailable/provisional — NEVER silently replaced by Euclidean distance.

Field mask is explicit and minimal. TRAFFIC_UNAWARE is used for constraint
validation so results are deterministic and comparable with the ORS fallback;
traffic-aware demand catchments stay in engine/traffic.py (computeRouteMatrix,
unchanged).
"""
from __future__ import annotations

import logging

import httpx

from ..config import get_settings
from .base import ProviderContext, ProviderResult, run_provider

logger = logging.getLogger(__name__)

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
ROUTES_FIELD_MASK = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"
TRAVEL_MODE = {"walk": "WALK", "drive": "DRIVE"}


def _headers() -> dict:
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": get_settings().google_places_api_key,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    }


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Decode a Google encoded polyline → [(lng, lat), ...] (shapely order)."""
    coords: list[tuple[float, float]] = []
    index, lat, lng = 0, 0, 0
    while index < len(encoded):
        for is_lng in (False, True):
            shift, result = 0, 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lng:
                lng += delta
            else:
                lat += delta
        coords.append((lng / 1e5, lat / 1e5))
    return coords


async def compute_route(
    origin: tuple[float, float],          # (lat, lng)
    dest: tuple[float, float],            # (lat, lng)
    mode: str,
    *,
    ctx: ProviderContext | None = None,
) -> ProviderResult:
    """One route. data = {distanceM, durationMin, geomCoords: [(lng,lat),...],
    encodedPolyline}."""
    s = get_settings()
    body = {
        "origin": {"location": {"latLng": {"latitude": origin[0], "longitude": origin[1]}}},
        "destination": {"location": {"latLng": {"latitude": dest[0], "longitude": dest[1]}}},
        "travelMode": TRAVEL_MODE.get(mode, "DRIVE"),
    }
    if body["travelMode"] == "DRIVE":
        body["routingPreference"] = "TRAFFIC_UNAWARE"

    async def call() -> dict:
        async with httpx.AsyncClient(timeout=s.google_routes_timeout_seconds) as client:
            r = await client.post(ROUTES_URL, json=body, headers=_headers())
            r.raise_for_status()
            raw = r.json()
        routes = raw.get("routes") or []
        if not routes:
            return {}
        rt = routes[0]
        duration_s = float(str(rt.get("duration", "0s")).rstrip("s") or 0)
        encoded = (rt.get("polyline") or {}).get("encodedPolyline", "")
        return {
            "distanceM": round(float(rt.get("distanceMeters", 0)), 1),
            "durationMin": round(duration_s / 60.0, 1),
            "geomCoords": decode_polyline(encoded) if encoded else [],
            "encodedPolyline": encoded,
        }

    return await run_provider(
        call, provider="groutes", feature="compute_route",
        timeout=s.google_routes_timeout_seconds + 2,
        max_retries=s.google_places_max_retries, ctx=ctx,
        cache_key=(
            f"route|{mode}|{round(origin[0],5)},{round(origin[1],5)}"
            f"|{round(dest[0],5)},{round(dest[1],5)}"
        ),
        empty_when=lambda d: not d,
    )
