"""Google Places API (New) — Nearby Search / Text Search / Search Along Route.

Primary POI source for google_places factor layers (v1.4.8):
  priority: Places (New) → legacy Nearby Search → OSM supplement (merged
  downstream by poi_merge, unchanged).

Field masks are EXPLICIT and minimal — never `*` (cost + payload control).
POIs are converted to the engine's internal dict shape ({lat, lng, tags:{…}})
plus placeId/rating/userRatingCount/priceLevel carried for evidence
enrichment only — numeric scoring keeps using validated counts, never these
raw fields.
"""
from __future__ import annotations

import logging

import httpx

from ..config import get_settings
from .base import ProviderContext, ProviderResult, run_provider

logger = logging.getLogger(__name__)

NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby"
TEXT_URL = "https://places.googleapis.com/v1/places:searchText"

# Minimal explicit field mask (Phase 5) — identical for Nearby and Text Search.
SEARCH_FIELD_MASK = ",".join([
    "places.id",
    "places.displayName",
    "places.location",
    "places.primaryType",
    "places.types",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.formattedAddress",
])

# Legacy place types that were renamed/split in Places API (New). Unknown
# types pass through unchanged; a genuinely invalid type fails that request
# (HTTP 400) and the caller falls back to the legacy API.
LEGACY_TO_NEW_TYPE = {
    "grocery_or_supermarket": "grocery_store",
    "lodging": "lodging",
}

MAX_SAMPLE_POINTS_NEW = 12     # New API is per-request billed — tighter than legacy's 25
PROBE_RADIUS_M = 1500.0        # parity with legacy data_places probe radius
MAX_RESULTS_PER_REQUEST = 20   # API maximum


def _headers() -> dict:
    # Key travels ONLY in this header; never logged (base.run_provider logs
    # provider/feature/status/elapsed only).
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": get_settings().google_places_api_key,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    }


# v1.6.8 — legacy meta-types that Places API (New) REJECTS as includedTypes.
# One invalid entry 400s the entire request (observed live: "Places Nearby
# (New) failed (http_400) — falling back to legacy Places").
_INVALID_NEW_TYPES = {
    "establishment", "point_of_interest", "premise", "subpremise",
    "political", "geocode", "plus_code", "food", "place_of_worship",
    "natural_feature", "intersection", "street_address", "route",
}


def map_types(types: list[str] | None) -> list[str]:
    mapped = [LEGACY_TO_NEW_TYPE.get(t, t) for t in (types or []) if t]
    kept = [t for t in mapped if t not in _INVALID_NEW_TYPES]
    dropped = [t for t in mapped if t in _INVALID_NEW_TYPES]
    if dropped:
        logger.info("places(new): dropped invalid includedTypes %s", dropped)
    # dedupe, order-preserving
    seen: set[str] = set()
    return [t for t in kept if not (t in seen or seen.add(t))]


def _place_to_poi(place: dict) -> dict | None:
    loc = place.get("location") or {}
    lat, lng = loc.get("latitude"), loc.get("longitude")
    if lat is None or lng is None:
        return None
    return {
        "lat": lat,
        "lng": lng,
        "tags": {
            "name": (place.get("displayName") or {}).get("text", ""),
            "google_type": place.get("primaryType") or "",
        },
        # Evidence-only fields (never used in numeric scoring):
        "placeId": place.get("id"),
        "rating": place.get("rating"),
        "userRatingCount": place.get("userRatingCount"),
        "priceLevel": place.get("priceLevel"),
        "source": "google_places_new",
    }


async def _post(url: str, body: dict, timeout: float) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, json=body, headers=_headers())
        r.raise_for_status()
        return r.json()


async def search_nearby(
    types: list[str],
    center: tuple[float, float],
    radius_m: float,
    *,
    ctx: ProviderContext | None = None,
) -> ProviderResult:
    """Nearby Search (New) around one point. data = {"pois": [...]}."""
    s = get_settings()
    new_types = map_types(types)
    if not new_types:
        # v1.6.8 — "includedTypes": [] is a guaranteed 400; skip the doomed
        # call and hand the layer to the legacy path with an honest reason.
        return ProviderResult(
            provider="placesnew", feature="nearby_search", status="degraded",
            data={"pois": []}, elapsed_ms=0,
            degradation_reason="no_valid_new_api_types_for_layer",
        )
    body = {
        "includedTypes": new_types,
        "maxResultCount": MAX_RESULTS_PER_REQUEST,
        "locationRestriction": {
            "circle": {
                "center": {"latitude": center[0], "longitude": center[1]},
                "radius": min(50_000.0, float(radius_m)),
            }
        },
    }

    async def call() -> dict:
        raw = await _post(NEARBY_URL, body, s.google_places_timeout_seconds)
        pois = [p for p in (_place_to_poi(pl) for pl in raw.get("places", [])) if p]
        return {"pois": pois}

    return await run_provider(
        call, provider="placesnew", feature="nearby_search",
        timeout=s.google_places_timeout_seconds + 2,
        max_retries=s.google_places_max_retries, ctx=ctx,
        cache_key=f"nearby|{sorted(new_types)}|{round(center[0],4)},{round(center[1],4)}|{int(radius_m)}",
        empty_when=lambda d: not d.get("pois"),
    )


async def search_text(
    query: str,
    bbox: tuple[float, float, float, float],
    *,
    included_type: str | None = None,
    ctx: ProviderContext | None = None,
) -> ProviderResult:
    """Text Search (New) with a rectangle location bias — for keyworded /
    ambiguous business-intent queries ("premium restaurant", "discount
    supermarket"). data = {"pois": [...]}."""
    s = get_settings()
    south, west, north, east = bbox
    body: dict = {
        "textQuery": query,
        "pageSize": MAX_RESULTS_PER_REQUEST,
        "locationBias": {
            "rectangle": {
                "low": {"latitude": south, "longitude": west},
                "high": {"latitude": north, "longitude": east},
            }
        },
    }
    if included_type:
        body["includedType"] = map_types([included_type])[0]

    async def call() -> dict:
        raw = await _post(TEXT_URL, body, s.google_places_timeout_seconds)
        pois = [p for p in (_place_to_poi(pl) for pl in raw.get("places", [])) if p]
        return {"pois": pois}

    return await run_provider(
        call, provider="placesnew", feature="text_search",
        timeout=s.google_places_timeout_seconds + 2,
        max_retries=s.google_places_max_retries, ctx=ctx,
        cache_key=f"text|{query}|{included_type}|{tuple(round(x,3) for x in bbox)}",
        empty_when=lambda d: not d.get("pois"),
    )


async def search_along_route(
    query: str,
    encoded_polyline: str,
    *,
    ctx: ProviderContext | None = None,
) -> ProviderResult:
    """Search Along Route: Text Search (New) with searchAlongRouteParameters.
    Requires a route polyline from google_routes.compute_route. Evidence /
    corridor-POI use only — never a direct numeric scoring input.
    Feature-flagged (enable_google_search_along_route, default OFF)."""
    s = get_settings()
    body = {
        "textQuery": query,
        "pageSize": MAX_RESULTS_PER_REQUEST,
        "searchAlongRouteParameters": {
            "polyline": {"encodedPolyline": encoded_polyline},
        },
    }

    async def call() -> dict:
        raw = await _post(TEXT_URL, body, s.google_places_timeout_seconds)
        pois = [p for p in (_place_to_poi(pl) for pl in raw.get("places", [])) if p]
        return {"pois": pois}

    return await run_provider(
        call, provider="placesnew", feature="search_along_route",
        timeout=s.google_places_timeout_seconds + 2,
        max_retries=s.google_places_max_retries, ctx=ctx,
        empty_when=lambda d: not d.get("pois"),
    )


def _sample_points(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    """Grid sample points over the bbox — same approach as the legacy fetcher
    but capped tighter (New API is per-request billed)."""
    from ..engine.data_places import _sample_points as legacy_points
    pts = legacy_points(bbox)
    if len(pts) > MAX_SAMPLE_POINTS_NEW:
        step = len(pts) / MAX_SAMPLE_POINTS_NEW
        pts = [pts[int(i * step)] for i in range(MAX_SAMPLE_POINTS_NEW)]
    return pts


async def fetch_pois_with_fallback(
    types: list[str] | None,
    keyword: str | None,
    bbox: tuple[float, float, float, float],
    *,
    legacy_fetch,
    ctx: ProviderContext | None = None,
) -> tuple[list[dict], str, list[str]]:
    """Area POI fetch with the v1.4.8 priority chain. NEVER raises.

    Priority:
      1. Places API (New) — Text Search when a keyword/business-intent query
         is present (the New Nearby Search has no keyword parameter),
         otherwise Nearby Search over grid sample points.
      2. Legacy Nearby Search (existing `data_places.fetch_places_pois`).
      3. Empty list (OSM supplement is merged downstream as before).

    Returns (pois, source_label, notes). A permanent provider failure yields
    ([], "none", notes) — degradation, not a crash (the caller's OSM merge and
    no-data factor handling take over).
    """
    s = get_settings()
    notes: list[str] = []

    if s.enable_google_places_new and s.google_places_api_key:
        try:
            if keyword:
                pr = await search_text(
                    keyword, bbox,
                    included_type=(types[0] if types else None), ctx=ctx,
                )
                if pr.status == "ok":
                    return pr.data["pois"], "google_places_new_text", notes
                notes.append(
                    f"Places Text Search (New) {pr.status}"
                    + (f" ({pr.degradation_reason})" if pr.degradation_reason else "")
                    + " — falling back to legacy Places."
                )
            else:
                seen: dict[str, dict] = {}
                any_ok = False
                hard_stop = False
                for lat, lng in _sample_points(bbox):
                    pr = await search_nearby(types or [], (lat, lng), PROBE_RADIUS_M, ctx=ctx)
                    if pr.status in ("disabled", "failed", "timeout", "degraded"):
                        # circuit/budget/API problems — stop burning sample points
                        notes.append(
                            f"Places Nearby (New) {pr.status}"
                            + (f" ({pr.degradation_reason})" if pr.degradation_reason else "")
                            + " — falling back to legacy Places."
                        )
                        hard_stop = True
                        break
                    any_ok = True
                    for p in pr.data.get("pois", []):
                        pid = p.get("placeId") or f"{p['lat']},{p['lng']}"
                        seen.setdefault(pid, p)
                if not hard_stop and any_ok:
                    return list(seen.values()), "google_places_new_nearby", notes
        except Exception as ex:  # defense-in-depth: this path must never raise
            notes.append(f"Places (New) unexpected error ({str(ex)[:120]}) — legacy fallback.")

    # Fallback: legacy Nearby Search (kept as-is — stable, grid-sampled)
    try:
        pois = await legacy_fetch(types or [], keyword, bbox)
        if pois:
            return pois, "google_places_legacy", notes
        notes.append("Legacy Places returned no POIs.")
        return [], "google_places_legacy", notes
    except Exception as ex:
        notes.append(
            f"Legacy Places fetch failed ({str(ex)[:120]}) — this layer relies on "
            "the OSM supplement only."
        )
        return [], "none", notes
