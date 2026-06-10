"""OSM data fetch via Overpass — one union query for all layers over the study bbox.

Production lessons baked in:
- overpass-api.de returns 406 without a descriptive User-Agent → always send one.
- Public endpoints throttle datacenter IPs → 3 endpoints, ONE attempt each with a
  moderate timeout (fail over fast rather than retrying a throttled host).
- The per-layer fallback runs with bounded concurrency, not serially (a serial
  fallback once turned a failed union query into a 15-minute hang).
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

logger = logging.getLogger(__name__)

OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",            # throttles least
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",  # fast mirror
    "https://overpass-api.de/api/interpreter",                  # canonical (strict)
]
HTTP_TIMEOUT = 50          # per endpoint; one attempt each → worst case ~2.5 min
USER_AGENT = "stratageo-engine/1.0.1 (site-suitability analysis; stratageo.in)"
FALLBACK_CONCURRENCY = 2   # parallel per-layer fetches if the union query fails

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
    return f"[out:json][timeout:45];({body});out center;"


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
    Falls back to bounded-concurrency per-layer fetches if the union query fails."""
    union_tags = sorted({t for tags in tag_sets.values() for t in tags})
    try:
        all_pois = await fetch_layer_pois(union_tags, bbox)
    except Exception as e:
        logger.warning("union Overpass fetch failed (%s) — falling back to per-layer", e)
        sem = asyncio.Semaphore(FALLBACK_CONCURRENCY)

        async def one(lid: str, tags: list[str]) -> tuple[str, list[dict]]:
            async with sem:
                try:
                    return lid, await fetch_layer_pois(tags, bbox)
                except Exception:
                    return lid, []

        results = await asyncio.gather(*(one(lid, tags) for lid, tags in tag_sets.items()))
        return dict(results)

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
    """Returns [{lat, lng, tags}] for all features matching any tag in bbox.
    One attempt per endpoint — throttled hosts rarely recover within a retry window,
    so failing over to the next mirror beats retrying the same one."""
    key = (tuple(round(x, 3) for x in bbox), tuple(sorted(tags)))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    # Persistent cache (survives Cloud Run scale-to-zero)
    from ..services import storage
    gcs_key = f"overpass/{storage.cache_key(key)}.json"
    if storage.enabled():
        cached = await storage.get_json(gcs_key)
        if cached is not None and time.time() - cached.get("ts", 0) < CACHE_TTL:
            pois = cached["pois"]
            _cache[key] = (time.time(), pois)
            logger.info("Overpass cache hit (GCS): %d POIs for %d tag(s)", len(pois), len(tags))
            return pois

    query = _build_query(tags, bbox)
    last_err: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT,
                headers={"User-Agent": USER_AGENT},
            ) as client:
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
            if storage.enabled():
                await storage.put_json(gcs_key, {"ts": time.time(), "pois": pois})
            logger.info("Overpass: %d POIs for %d tag(s) via %s", len(pois), len(tags), endpoint)
            return pois
        except Exception as e:
            last_err = e
            logger.warning("Overpass attempt failed (%s): %s", endpoint, e)
            await asyncio.sleep(1)
    raise RuntimeError(f"Overpass fetch failed for tags={tags}: {last_err}")
