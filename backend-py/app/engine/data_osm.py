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
HTTP_TIMEOUT = 25          # per endpoint; one attempt each → worst case ~77s (was 50s/152s)
USER_AGENT = "stratageo-engine/1.0.2 (site-suitability analysis; stratageo.in)"
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


def _build_geom_query(tags: list[str], bbox: tuple[float, float, float, float]) -> str:
    """Way geometry (full polylines, not centroids) for linear-feature corridors."""
    s, w, n, e = bbox
    parts = []
    for tag in tags:
        k, v = tag.split("=", 1)
        sel = f'["{k}"]' if v == "*" else f'["{k}"="{v}"]'
        parts.append(f"way{sel}({s},{w},{n},{e});")
    body = "".join(parts)
    return f"[out:json][timeout:45];({body});out geom;"


async def fetch_line_geometries(
    tags: list[str],
    bbox: tuple[float, float, float, float],
) -> list[dict]:
    """Returns [{geometry: [{lat,lng}, ...], tags}] for ways matching any tag.

    Unlike fetch_layer_pois (which uses `out center` → one centroid per way),
    this uses `out geom` to recover the full polyline so corridors can measure
    TRUE distance-to-line. Same endpoint failover + GCS cache as the POI fetch.
    """
    key = (("geom",) + tuple(round(x, 3) for x in bbox), tuple(sorted(tags)))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    from ..services import storage
    gcs_key = f"overpass/{storage.cache_key(key)}.json"
    if storage.enabled():
        cached = await storage.get_json(gcs_key)
        if cached is not None and time.time() - cached.get("ts", 0) < CACHE_TTL:
            ways = cached["ways"]
            _cache[key] = (time.time(), ways)
            logger.info("Overpass geom cache hit (GCS): %d ways for %d tag(s)", len(ways), len(tags))
            return ways

    query = _build_geom_query(tags, bbox)
    logger.debug("Overpass geom query (%d tag(s)): %s", len(tags), query[:400])
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
            ways = []
            for el in data.get("elements", []):
                if el.get("type") != "way":
                    continue
                geom = [
                    {"lat": g["lat"], "lng": g["lon"]}
                    for g in el.get("geometry", [])
                    if g.get("lat") is not None and g.get("lon") is not None
                ]
                if len(geom) >= 2:
                    ways.append({"geometry": geom, "tags": el.get("tags", {})})
            _cache[key] = (time.time(), ways)
            if storage.enabled():
                await storage.put_json(gcs_key, {"ts": time.time(), "ways": ways})
            logger.info("Overpass geom: %d ways for %d tag(s) via %s", len(ways), len(tags), endpoint)
            return ways
        except Exception as e:
            last_err = e
            logger.warning("Overpass geom attempt failed (%s): %s", endpoint, e)
            await asyncio.sleep(0.5)
    raise RuntimeError(f"Overpass geom fetch failed for tags={tags}: {last_err}")


def _build_area_query(tags: list[str], bbox: tuple[float, float, float, float]) -> str:
    """Ways AND relations (multipolygons) for area features — water bodies are
    often relations (a big river is one relation, not a tagged way)."""
    s, w, n, e = bbox
    parts = []
    for tag in tags:
        k, v = tag.split("=", 1)
        sel = f'["{k}"]' if v == "*" else f'["{k}"="{v}"]'
        parts.append(f"way{sel}({s},{w},{n},{e});")
        parts.append(f"relation{sel}({s},{w},{n},{e});")
    body = "".join(parts)
    return f"[out:json][timeout:45];({body});out geom;"


async def fetch_area_geometries(
    tags: list[str],
    bbox: tuple[float, float, float, float],
) -> list[dict]:
    """Returns [{geometry: [{lat,lng}, ...], tags}] for AREA features, including
    relation members. Unlike fetch_line_geometries (ways only), this also returns
    the member ways of matching multipolygon RELATIONS — so a river/lake mapped as
    a relation (not a tagged way) is recovered and can be polygonized. Same
    endpoint-failover + GCS cache as the other geometry fetch.
    """
    key = (("area",) + tuple(round(x, 3) for x in bbox), tuple(sorted(tags)))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    from ..services import storage
    gcs_key = f"overpass/{storage.cache_key(key)}.json"
    if storage.enabled():
        cached = await storage.get_json(gcs_key)
        if cached is not None and time.time() - cached.get("ts", 0) < CACHE_TTL:
            feats = cached["feats"]
            _cache[key] = (time.time(), feats)
            logger.info("Overpass area cache hit (GCS): %d features", len(feats))
            return feats

    def _coords(geom):
        return [
            {"lat": g["lat"], "lng": g["lon"]}
            for g in (geom or [])
            if g.get("lat") is not None and g.get("lon") is not None
        ]

    query = _build_area_query(tags, bbox)
    logger.debug("Overpass area query (%d tag(s)): %s", len(tags), query[:400])
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
            feats = []
            for el in data.get("elements", []):
                if el.get("type") == "way":
                    geom = _coords(el.get("geometry"))
                    if len(geom) >= 2:
                        feats.append({"geometry": geom, "tags": el.get("tags", {})})
                elif el.get("type") == "relation":
                    for m in el.get("members", []):
                        if m.get("type") != "way":
                            continue
                        geom = _coords(m.get("geometry"))
                        if len(geom) >= 2:
                            feats.append({"geometry": geom, "tags": el.get("tags", {}), "role": m.get("role")})
            _cache[key] = (time.time(), feats)
            if storage.enabled():
                await storage.put_json(gcs_key, {"ts": time.time(), "feats": feats})
            logger.info("Overpass area: %d features for %d tag(s) via %s", len(feats), len(tags), endpoint)
            return feats
        except Exception as e:
            last_err = e
            logger.warning("Overpass area attempt failed (%s): %s", endpoint, e)
            await asyncio.sleep(0.5)
    raise RuntimeError(f"Overpass area fetch failed for tags={tags}: {last_err}")


async def fetch_named_features(
    name_regex: str,
    bbox: tuple[float, float, float, float],
) -> list[dict]:
    """Nodes + ways whose `name` matches a case-insensitive regex (e.g. "ghat").

    Returns [{lat, lng, name}] using centroids. Used by the buildability ghat mask:
    ghats are tagged inconsistently (tourism/amenity/leisure/place), so a name match
    is the reliable signal. Same failover + caching as the other fetches.
    """
    key = (("named",) + tuple(round(x, 3) for x in bbox), (name_regex,))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    from ..services import storage
    gcs_key = f"overpass/{storage.cache_key(key)}.json"
    if storage.enabled():
        cached = await storage.get_json(gcs_key)
        if cached is not None and time.time() - cached.get("ts", 0) < CACHE_TTL:
            feats = cached["feats"]
            _cache[key] = (time.time(), feats)
            return feats

    s, w, n, e = bbox
    sel = f'["name"~"{name_regex}",i]'
    query = (
        f"[out:json][timeout:45];"
        f"(node{sel}({s},{w},{n},{e});way{sel}({s},{w},{n},{e}););out center;"
    )
    logger.debug("Overpass named query (%r): %s", name_regex, query[:400])
    last_err: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT},
            ) as client:
                r = await client.post(endpoint, data={"data": query})
                r.raise_for_status()
                data = r.json()
            feats = []
            for el in data.get("elements", []):
                if el.get("type") == "node":
                    lat, lng = el.get("lat"), el.get("lon")
                else:
                    c = el.get("center") or {}
                    lat, lng = c.get("lat"), c.get("lon")
                if lat is None or lng is None:
                    continue
                feats.append({"lat": lat, "lng": lng, "name": el.get("tags", {}).get("name", "")})
            _cache[key] = (time.time(), feats)
            if storage.enabled():
                await storage.put_json(gcs_key, {"ts": time.time(), "feats": feats})
            logger.info("Overpass named(%r): %d features via %s", name_regex, len(feats), endpoint)
            return feats
        except Exception as ex:
            last_err = ex
            logger.warning("Overpass named fetch failed (%s): %s", endpoint, ex)
            await asyncio.sleep(0.5)
    logger.warning("Overpass named fetch failed for %r: %s", name_regex, last_err)
    return []   # buildability is best-effort — never hard-fail the analysis


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
    logger.debug("Overpass POI query (%d tag(s)): %s", len(tags), query[:400])
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
            await asyncio.sleep(0.5)
    raise RuntimeError(f"Overpass fetch failed for tags={tags}: {last_err}")
