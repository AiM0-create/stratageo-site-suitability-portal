"""Metro / subway station resolver — v1.4.0.

Phase 8: Metro exclusion must use VERIFIED metro stations, not generic railway
stations. This module provides:
  1. Static verified metro station lists for cities where we have test prompts.
  2. OSM tag-based metro detection (prefers subway-tagged stations over generic rail).
  3. Fallback mode detection so the evidence trail can report the confidence tier.

Usage in jobs.py:
    from ..engine.metro import resolve_metro_stations, MetroResolutionMode

Design rules:
- Static lists are city-specific and tagged with the source date.
- OSM fallback uses station=subway / subway=yes as the strongest signal.
- Generic railway=station fallback is the WEAKEST — must be declared so the
  caller can downgrade confidence.
- Never use generic railway=station alone for metro exclusion when metro-specific
  data is available.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

MetroResolutionMode = Literal[
    "static_verified",          # from hardcoded verified city list
    "osm_metro",                # OSM station=subway / subway=yes tags
    "generic_station_fallback", # fell back to generic railway=station
    "unavailable",              # no station data could be resolved
]

# ── Static verified metro station lists ───────────────────────────────────────
# Source: Official metro network maps.  Update when new stations open.
# Format: list of {"name": str, "lat": float, "lng": float, "line": str}

KOLKATA_METRO_STATIONS: list[dict] = [
    # Blue Line (N-S Corridor) — Kabi Subhas to Dakshineswar
    {"name": "Kabi Subhas",        "lat": 22.4533, "lng": 88.3864, "line": "Blue"},
    {"name": "Shahid Khudiram",    "lat": 22.4633, "lng": 88.3853, "line": "Blue"},
    {"name": "Kavi Nazrul",        "lat": 22.4732, "lng": 88.3846, "line": "Blue"},
    {"name": "Netaji Bhavan",      "lat": 22.4822, "lng": 88.3832, "line": "Blue"},
    {"name": "Masterda Surya Sen", "lat": 22.4882, "lng": 88.3823, "line": "Blue"},
    {"name": "Gitanjali",          "lat": 22.4943, "lng": 88.3812, "line": "Blue"},
    {"name": "Mahanayak Uttam Kumar", "lat": 22.4996, "lng": 88.3805, "line": "Blue"},
    {"name": "Tollygunge",         "lat": 22.5053, "lng": 88.3476, "line": "Blue"},
    {"name": "Rabindra Sarobar",   "lat": 22.5133, "lng": 88.3424, "line": "Blue"},
    {"name": "Maidan",             "lat": 22.5488, "lng": 88.3449, "line": "Blue"},
    {"name": "Esplanade",          "lat": 22.5609, "lng": 88.3474, "line": "Blue"},
    {"name": "Chandni Chowk",      "lat": 22.5691, "lng": 88.3482, "line": "Blue"},
    {"name": "Central",            "lat": 22.5741, "lng": 88.3494, "line": "Blue"},
    {"name": "Girish Park",        "lat": 22.5802, "lng": 88.3513, "line": "Blue"},
    {"name": "Shyambazar",         "lat": 22.5868, "lng": 88.3655, "line": "Blue"},
    {"name": "Shobhabazar Sutanuti","lat": 22.5936, "lng": 88.3693, "line": "Blue"},
    {"name": "Belgachia",          "lat": 22.6011, "lng": 88.3732, "line": "Blue"},
    {"name": "Noapara",            "lat": 22.6154, "lng": 88.3855, "line": "Blue"},
    {"name": "Baranagar",          "lat": 22.6294, "lng": 88.3874, "line": "Blue"},
    {"name": "Dakshineswar",       "lat": 22.6576, "lng": 88.3597, "line": "Blue"},
    # Green Line (E-W Corridor) — Howrah Maidan to Salt Lake Sector V
    {"name": "Howrah Maidan",      "lat": 22.5740, "lng": 88.3305, "line": "Green"},
    {"name": "Howrah",             "lat": 22.5830, "lng": 88.3423, "line": "Green"},
    {"name": "Mahakaran",          "lat": 22.5726, "lng": 88.3387, "line": "Green"},
    {"name": "Esplanade",          "lat": 22.5604, "lng": 88.3487, "line": "Green"},
    {"name": "Sealdah",            "lat": 22.5656, "lng": 88.3718, "line": "Green"},
    {"name": "Phoolbagan",         "lat": 22.5660, "lng": 88.3838, "line": "Green"},
    {"name": "Salt Lake Sector V", "lat": 22.5691, "lng": 88.4326, "line": "Green"},
    {"name": "Salt Lake Stadium",  "lat": 22.5597, "lng": 88.4103, "line": "Green"},
    {"name": "Phoolbagan (Green)", "lat": 22.5664, "lng": 88.3839, "line": "Green"},
    # Ballygunge area (on Blue line)
    {"name": "Rabindra Sarobar",   "lat": 22.5133, "lng": 88.3424, "line": "Blue"},
]

# Index by city name (lowercase)
_CITY_STATIONS: dict[str, list[dict]] = {
    "kolkata": KOLKATA_METRO_STATIONS,
    "calcutta": KOLKATA_METRO_STATIONS,
}

# ── OSM tags that reliably indicate metro / subway stations ───────────────────
METRO_OSM_TAGS = [
    "station=subway",
    "subway=yes",
    "railway=subway_entrance",
    "network=Kolkata Metro",
    "network=Delhi Metro",
    "network=Namma Metro",
    "network=Mumbai Metro",
    "network=Hyderabad Metro",
    "network=Chennai Metro",
]

# Tags that indicate a metro station via combined signals
METRO_RAILWAY_TAGS_PREFERRED = [
    "railway=station",
    "station=subway",
    "subway=yes",
]

# Fallback: any station (weakest signal for metro identification)
GENERIC_STATION_TAGS = ["railway=station", "public_transport=station"]

# ── City detection from study area or prompt ──────────────────────────────────
_CITY_RE: dict[str, re.Pattern] = {
    "kolkata": re.compile(r"\b(kolkata|calcutta|kolkotta|howrah|salt\s+lake|new\s+town|kalyani)\b", re.I),
    "delhi": re.compile(r"\b(delhi|new\s+delhi|ncr|gurgaon|gurugram|noida|faridabad|ghaziabad)\b", re.I),
    "bangalore": re.compile(r"\b(bengaluru|bangalore|banglore)\b", re.I),
    "mumbai": re.compile(r"\b(mumbai|bombay|thane|navi\s+mumbai)\b", re.I),
    "hyderabad": re.compile(r"\b(hyderabad|secunderabad|cyberabad)\b", re.I),
    "chennai": re.compile(r"\b(chennai|madras)\b", re.I),
}


def detect_city(text: str) -> str | None:
    """Detect city name from prompt/area text. Returns lowercase city key."""
    for city, pat in _CITY_RE.items():
        if pat.search(text or ""):
            return city
    return None


@dataclass
class MetroResolutionResult:
    mode: MetroResolutionMode = "unavailable"
    stations: list[dict] = field(default_factory=list)
    station_count: int = 0
    city: str | None = None
    osm_tags_used: list[str] = field(default_factory=list)
    confidence: Literal["high", "medium", "low"] = "low"
    warning: str | None = None

    def to_evidence_dict(self) -> dict:
        return {
            "mode": self.mode,
            "stationCount": self.station_count,
            "city": self.city,
            "osmTagsUsed": self.osm_tags_used,
            "confidence": self.confidence,
            "warning": self.warning,
        }


def resolve_metro_stations(
    prompt_text: str,
    study_area_text: str = "",
    osm_fetched_stations: list[dict] | None = None,
) -> MetroResolutionResult:
    """Resolve the best available metro station set for a given study area.

    Priority:
    1. Static verified list (highest confidence) — when city is detected.
    2. OSM stations with subway tags (medium confidence).
    3. Generic OSM railway=station fallback (low confidence — triggers advisory).
    4. Unavailable.

    Args:
        prompt_text: The raw user prompt (for city detection).
        study_area_text: Study area names / place labels.
        osm_fetched_stations: Stations fetched from OSM, pre-filtered for the bbox.

    Returns a MetroResolutionResult describing what was found.
    """
    full_text = f"{prompt_text} {study_area_text}"
    city = detect_city(full_text)

    # ── Try static verified list ───────────────────────────────────────────────
    if city and city in _CITY_STATIONS:
        stations = _CITY_STATIONS[city]
        return MetroResolutionResult(
            mode="static_verified",
            stations=stations,
            station_count=len(stations),
            city=city,
            osm_tags_used=[],
            confidence="high",
        )

    # ── Try OSM subway-tagged stations ────────────────────────────────────────
    if osm_fetched_stations:
        subway_stations = [
            s for s in osm_fetched_stations
            if s.get("tags", {}).get("station") == "subway"
            or s.get("tags", {}).get("subway") == "yes"
            or "subway" in str(s.get("tags", {})).lower()
        ]
        if subway_stations:
            return MetroResolutionResult(
                mode="osm_metro",
                stations=subway_stations,
                station_count=len(subway_stations),
                city=city,
                osm_tags_used=METRO_OSM_TAGS[:2],
                confidence="medium",
            )

        # Generic station fallback
        if osm_fetched_stations:
            return MetroResolutionResult(
                mode="generic_station_fallback",
                stations=osm_fetched_stations,
                station_count=len(osm_fetched_stations),
                city=city,
                osm_tags_used=GENERIC_STATION_TAGS,
                confidence="low",
                warning=(
                    "Metro exclusion used generic railway stations as proxy "
                    "because no subway-tagged stations were found in OSM. "
                    "Some stations may not be metro lines — verify with local knowledge."
                ),
            )

    return MetroResolutionResult(
        mode="unavailable",
        stations=[],
        station_count=0,
        city=city,
        confidence="low",
        warning="No metro station data could be resolved for this area.",
    )


def get_metro_exclusion_tags(mode: MetroResolutionMode) -> list[str]:
    """Return the OSM tags to use for metro exclusion given the resolution mode."""
    if mode == "static_verified":
        return []  # Static list used directly, no OSM tags needed
    if mode == "osm_metro":
        return METRO_OSM_TAGS
    return GENERIC_STATION_TAGS  # fallback
