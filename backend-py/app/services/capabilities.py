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
        ],
    }
