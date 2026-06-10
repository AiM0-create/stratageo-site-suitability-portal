"""OSM data fetch via Overpass — one query per layer tag-set over the study bbox."""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

logger = logging.getLogger(__name__)

OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",   # tends to throttle less
    "https://overpass-api.de/api/interpreter",
]
HTTP_TIMEOUT = 75  # union queries are heavier; fail over after this

# (bbox_key, tags_key) → (timestamp, pois)
_cache: dict[tuple, tuple[float, list[dict]]] = {}
CACHE_TTL = 6 * 3600


def _build_query(tags: list[str], bbox: tuple[float, float, float, float]) -> str:
    """bbox = (south, west, north, east) — Overpass order."""
    s, w, n, e = bbox
    parts = []
    for tag in tags:
        k, v = tag.split("=", 1)
        sel = f'["{k}"]' if v == "*" else f'["{k}"="{v}"]'
        parts.append(f"node{sel}({s},{w},{n},{e});")
        parts.append(f"way{sel}({s},{w},{n},{e});")
    body = "".join(parts)
    return f"[out:json][timeout:60];({body});out center;"


def _classify(poi_tags: dict, layer_tags: list[str]) -> bool:
    """Does this element match any of the layer's key=value selectors?"""
    for t in layer_tags:
        k, v = t.split("=", 1)
        if k in poi_tags and (v == "*" or poi_tags[k] == v):
            return True
    return False


async def fetch_all_layers(
    tag_sets: dict[str, list[str]],
    bbox: tuple[float, float, float, float],
) -> dict[str, list[dict]]:
    """ONE Overpass query for the union of all layers' tags, classified client-side.

    Collapses N sequential round-trips (the v1 bottleneck: ~3 min/layer when the
    primary endpoint throttles) into a single fetch + local bucketing.
    Falls back to per-layer fetches if the union query fails.
    """
    union_tags = sorted({t for tags in tag_sets.values() for t in tags})
    try:
        all_pois = await fetch_layer_pois(union_tags, bbox)
    except Exception as e:
        logger.warning("union Overpass fetch failed (%s) — falling back to per-layer", e)
        out: dict[str, list[dict]] = {}
        for lid, tags in tag_sets.items():
            try:
                out[lid] = await fetch_layer_pois(tags, bbox)
            except Exception:
                out[lid] = []
        return out

    out = {lid: [] for lid in tag_sets}
    for poi in all_pois:
        for lid, tags in tag_sets.items():
            if _classify(poi.get("tags", {}), tags):
                out[lid].append(poi)
    for lid, pois in out.items():
        logger.info("layer %s: %d POIs (from union fetch)", lid, len(pois))
    return out


async def fetch_layer_pois(
    tags: list[str],
    bbox: tuple[float, float, float, float],
) -> list[dict]:
    """Returns [{lat, lng, tags}] for all features matching any tag in bbox."""
    key = (tuple(round(x, 3) for x in bbox), tuple(sorted(tags)))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    query = _build_query(tags, bbox)
    last_err: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
                    r = await client.post(endpoint, data={"data": query})
                    r.raise_for_status()
                    data = r.json()
                pois = []
                for el in data.get("elements", []):
                    if el["type"] == "node":
                        lat, lng = el.get("lat"), el.get("lon")
                    else:
                        c = el.get("center") or {}
                        lat, lng = c.get("lat"), c.get("lon")
                    if lat is None or lng is None:
                        continue
                    pois.append({"lat": lat, "lng": lng, "tags": el.get("tags", {})})
                _cache[key] = (time.time(), pois)
                logger.info("Overpass: %d POIs for tags=%s", len(pois), tags)
                return pois
            except Exception as e:
                last_err = e
                logger.warning("Overpass attempt failed (%s, try %d): %s", endpoint, attempt + 1, e)
                await asyncio.sleep(2)
    raise RuntimeError(f"Overpass fetch failed for tags={tags}: {last_err}")
