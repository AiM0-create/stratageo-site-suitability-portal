"""Traffic-aware drive catchment via Google Routes API (Phase 2, v1.0.1.7).

For DESTINATION businesses (preschool, clinic, gym, supermarket, dark kitchen,
hospital), demand = how much residential/POI density is reachable within an
N-minute DRIVE in typical traffic — a far better proxy than a straight-line
circle. This is NOT a footfall/pass-by signal and must not be used for
impulse/walk-by businesses (cafe, QSR) — the consultant gates that.

Cost control: only top-K candidates, demand points sampled (cap), one
computeRouteMatrix call per candidate (1 origin × N dests), GCS-cached. Uses a
fixed 'typical weekday peak' departure so results are stable and cacheable
(not live 'now').
"""
from __future__ import annotations

import datetime as _dt
import logging

import httpx

from ..config import get_settings
from ..services import storage

logger = logging.getLogger(__name__)

ROUTE_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
FIELD_MASK = "originIndex,destinationIndex,duration,staticDuration,distanceMeters,condition"
MAX_DEMAND_SAMPLE = 20          # destinations per candidate (cost bound)


def typical_peak_departure() -> str:
    """Next weekday 18:00 IST as an RFC3339 UTC timestamp — a stable 'typical
    evening peak' so traffic estimates are representative and cacheable."""
    now = _dt.datetime.now(_dt.timezone.utc)
    ist = now + _dt.timedelta(hours=5, minutes=30)
    # advance to the next day that is a weekday (Mon–Fri) at 18:00 IST
    target = ist.replace(hour=18, minute=0, second=0, microsecond=0)
    if target <= ist:
        target += _dt.timedelta(days=1)
    while target.weekday() >= 5:    # Sat/Sun → push to Monday
        target += _dt.timedelta(days=1)
    utc = target - _dt.timedelta(hours=5, minutes=30)
    return utc.strftime("%Y-%m-%dT%H:%M:%SZ")


async def traffic_catchment(
    origin: tuple[float, float],            # (lat, lng)
    demand_points: list[tuple[float, float]],
    max_minutes: float,
) -> tuple[int | None, float | None]:
    """Returns (reachable_count, congestion_ratio).

    reachable_count = demand points within max_minutes DRIVE in typical traffic.
    congestion_ratio = mean(traffic_time / free_flow_time) over the routed pairs
    (>1 = congested; a low-confidence 'area activity' signal).
    (None, None) when the key/API is unavailable — never fabricated.
    """
    s = get_settings()
    if not s.google_places_api_key or not demand_points:
        return None, None

    dests = demand_points[:MAX_DEMAND_SAMPLE]
    key = f"traffic/{storage.cache_key((round(origin[0],5), round(origin[1],5), tuple((round(la,4),round(ln,4)) for la,ln in dests), round(max_minutes,1)))}.json"
    if storage.enabled():
        cached = await storage.get_json(key)
        if cached is not None:
            return cached["reachable"], cached["congestion"]

    body = {
        "origins": [{"waypoint": {"location": {"latLng": {"latitude": origin[0], "longitude": origin[1]}}}}],
        "destinations": [
            {"waypoint": {"location": {"latLng": {"latitude": la, "longitude": ln}}}} for la, ln in dests
        ],
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "departureTime": typical_peak_departure(),
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                ROUTE_MATRIX_URL,
                json=body,
                headers={"Content-Type": "application/json",
                         "X-Goog-Api-Key": s.google_places_api_key,
                         "X-Goog-FieldMask": FIELD_MASK},
            )
            r.raise_for_status()
            rows = r.json()
    except Exception as e:
        logger.warning("Routes matrix failed (%s dests): %s", len(dests), e)
        return None, None

    reachable = 0
    ratios = []
    for row in rows:
        if row.get("condition") != "ROUTE_EXISTS":
            continue
        dur = row.get("duration")
        stat = row.get("staticDuration")
        if not dur:
            continue
        tmin = int(str(dur).rstrip("s")) / 60.0
        if tmin <= max_minutes:
            reachable += 1
        if stat:
            smin = int(str(stat).rstrip("s")) / 60.0
            if smin > 0:
                ratios.append(tmin / smin)

    congestion = round(sum(ratios) / len(ratios), 3) if ratios else None
    if storage.enabled():
        await storage.put_json(key, {"reachable": reachable, "congestion": congestion})
    return reachable, congestion
