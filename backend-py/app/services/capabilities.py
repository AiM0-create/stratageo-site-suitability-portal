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
        "routing": (
            "NETWORK ROUTING (ORS Directions, real shortest-path) IS supported for the "
            "top candidates via routeConstraints: door-to-door walk/drive distance + time "
            "from each candidate to a named target (geocoded) or the nearest feature of a "
            "tag-set; optional barrier avoidance (route AROUND railway corridors via "
            "avoid_polygons) and railway-CROSSING detection on the computed path. Use this "
            "for hard constraints like 'within 500m of X', 'walk under 7 minutes', 'without "
            "crossing railway tracks'. Note: scoring-LAYER walk/drive catchments remain "
            "calibrated isochrones/proxies; precise point-to-point checks use routeConstraints."
        ),
        "trafficAwareCatchment": (
            "A drive scoring-layer may set catchment.trafficAware=true to count demand "
            "reachable within N minutes of DRIVE in TYPICAL TRAFFIC (Google Routes, "
            "weekday evening peak) instead of free-flow. This is a CATCHMENT/REACHABILITY "
            "signal for DESTINATION businesses (preschool, clinic, gym, supermarket, dark "
            "kitchen, hospital, hotel) — people drive TO them. It is NOT a footfall/pass-by "
            "signal: NEVER set trafficAware on impulse/walk-by businesses (cafe, QSR, "
            "kiosk, convenience) — their demand is pedestrian, use walk/foot-traffic layers. "
            "The engine also surfaces a per-candidate congestion ratio (typical-peak vs "
            "free-flow) as a LOW-confidence 'area activity' indicator, shown for context."
        ),
        "scoring": "per-hex weighted sum; percentile (p5–p95) or min-max normalization per layer; "
                   "negative-direction layers inverted; user weights preserved exactly (renormalized to sum 1, never clamped)",
        "exclusions": "hard mask: hex excluded if any exclusion-tag POI within bufferM",
        "corridors": (
            "LINEAR-feature proximity gate: real way GEOMETRY (highway/arterial/river/"
            "coast/rail) is fetched and each hex is masked by TRUE distance-to-nearest-"
            "line. mode=include keeps hexes within maxDistanceM of the line ('within 5km "
            "of NH-48'); mode=exclude masks hexes within maxDistanceM ('away from the "
            "river'). Use this for 'within X of a road/river/coast' — NOT a POI-count "
            "scoring layer (a line reduces to a centroid when counted and floors to 0)."
        ),
        "output": "top-N hexes (spatially deduplicated), reverse-geocoded names, per-layer score breakdown, POIs for heatmaps",
        "notSupported": [
            "demographics / census / income data",
            "traffic counts or congestion data",
            "land prices / rents / real-estate listings",
            "raster, terrain, slope, or satellite imagery",
            "real-time or historical time-series data",
            "arbitrary file or external-API ingestion",
            "live/current traffic conditions (Phase 2 will add typical traffic-aware drive times)",
            "ROUTE barrier avoidance for rivers/walls/fences (only railway corridors are "
            "modeled; note distance-to-river/coast IS available as a corridor gate)",
        ],
    }
