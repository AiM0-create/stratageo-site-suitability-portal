"""Single source of truth for what the engine can and cannot do.

Injected verbatim into the chat system prompt AND enforced by SpecV2 pydantic
validation — the LLM cannot promise what the engine will reject.
"""
from ..config import get_settings


def capability_manifest() -> dict:
    s = get_settings()
    return {
        "grid": {
            "type": "h3",
            "resolutions": [7, 8, 9, 10],
            "default": 9,
            "autoDegrade": f"if study area exceeds {s.max_hexes} hexes, resolution drops by 1 (recorded in meta)",
        },
        "dataSources": {
            "osm": "OpenStreetMap via Overpass — any key=value tag query (counts of nodes/ways per catchment)",
            "google_places": "Google Places Nearby Search by type/keyword (max 3 such layers per analysis)",
            "custom": (
                "EXPERIMENTAL, currently "
                + ("ENABLED" if s.sandbox_enabled else "DISABLED")
                + " — small Python snippet computing a per-hex value from already-fetched POIs; no network, no files"
            ),
        },
        "catchments": {
            "euclidean": "straight-line radius in meters around hex centroid",
            "walk": "N-minute walking isochrone (OpenRouteService)",
            "drive": "N-minute driving isochrone (OpenRouteService)",
            "isochroneStrategy": (
                f"two-pass: all hexes scored with calibrated Euclidean proxies "
                f"(walk={s.walk_speed_m_per_min:.0f} m/min, drive={s.drive_speed_m_per_min:.0f} m/min), "
                f"then the top ~{s.refine_top_k} candidates are re-scored with true isochrones. "
                "Be transparent with the user about this."
            ),
            "maxIsochroneLayers": 4,
            "IMPORTANT_limits": (
                "Walk/drive catchments are travel-time ISOCHRONES over the general road "
                "network — they are NOT door-to-door pedestrian shortest-path routing and do "
                "NOT model physical barriers (railway tracks, rivers, walls, fences) or "
                "pedestrian-only access. The engine CANNOT compute: nearest station entrance, "
                "exact walk distance/time to a specific point, whether a route crosses railway "
                "tracks, or barrier-free pedestrian accessibility. Constraints that depend on "
                "these (e.g. 'walk under 7 min WITHOUT crossing railway tracks') are NOT "
                "verifiable — treat them as insufficient_data, never fabricate a pass/fail."
            ),
        },
        "scoring": "per-hex weighted sum; percentile (p5–p95) or min-max normalization per layer; "
                   "negative-direction layers inverted; user weights preserved exactly (renormalized to sum 1, never clamped)",
        "exclusions": "hard mask: hex excluded if any exclusion-tag POI within bufferM",
        "output": "top-N hexes (spatially deduplicated), reverse-geocoded names, per-layer score breakdown, POIs for heatmaps",
        "notSupported": [
            "demographics / census / income data",
            "traffic counts or congestion data",
            "land prices / rents / real-estate listings",
            "raster, terrain, slope, or satellite imagery",
            "real-time or historical time-series data",
            "arbitrary file or external-API ingestion",
            "pedestrian shortest-path routing or door-to-door walk distance/time",
            "barrier-aware accessibility (avoiding railway tracks, rivers, walls)",
            "railway-crossing / level-crossing detection along a route",
            "nearest station entrance / specific-point proximity (only area density)",
        ],
    }
