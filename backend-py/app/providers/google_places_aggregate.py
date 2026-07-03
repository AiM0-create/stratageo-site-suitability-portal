"""Google Places Aggregate (Area Insights) — authoritative POI counts.

computeInsights(INSIGHT_COUNT) returns the count of matching places within an
area from Google's full index — better count intelligence than counting our
grid-sampled POI fetches. Used ONLY for top-K candidate refinement (bounded
call volume), feeding scores[layer].refined[candidate] as a validated float.

NOT used for: rent, parcel size, legal buildability, or site availability —
those remain unverifiable from Places data by product policy.

The API may not be enabled for a given key/project (HTTP 403/404) — the
provider then self-reports status="disabled" once and the engine keeps the
existing isochrone/Euclidean refinement values.
"""
from __future__ import annotations

import logging

import httpx

from ..config import get_settings
from .base import ProviderContext, ProviderResult, run_provider
from .google_places_new import map_types

logger = logging.getLogger(__name__)

INSIGHTS_URL = "https://areainsights.googleapis.com/v1:computeInsights"


def _headers() -> dict:
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": get_settings().google_places_api_key,
    }


async def compute_count(
    center: tuple[float, float],
    radius_m: float,
    included_types: list[str] | None,
    *,
    ctx: ProviderContext | None = None,
) -> ProviderResult:
    """Count of operating places of the given types within a circle.
    data = {"count": int}."""
    s = get_settings()
    body = {
        "insights": ["INSIGHT_COUNT"],
        "filter": {
            "locationFilter": {
                "circle": {
                    "latLng": {"latitude": center[0], "longitude": center[1]},
                    "radius": int(min(50_000, max(1, radius_m))),
                }
            },
            "typeFilter": {"includedTypes": map_types(included_types or [])},
            "operatingStatus": ["OPERATING_STATUS_OPERATIONAL"],
        },
    }

    async def call() -> dict:
        async with httpx.AsyncClient(timeout=s.google_places_aggregate_timeout_seconds) as client:
            r = await client.post(INSIGHTS_URL, json=body, headers=_headers())
            r.raise_for_status()
            raw = r.json()
        # API returns count as a string per proto3 int64 JSON mapping.
        return {"count": int(raw.get("count", 0))}

    return await run_provider(
        call, provider="gaggregate", feature="insight_count",
        timeout=s.google_places_aggregate_timeout_seconds + 2,
        max_retries=s.google_places_max_retries, ctx=ctx,
        cache_key=(
            f"agg|{sorted(map_types(included_types or []))}"
            f"|{round(center[0],4)},{round(center[1],4)}|{int(radius_m)}"
        ),
    )
