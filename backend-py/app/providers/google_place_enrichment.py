"""Place Details (New) — evidence-POI enrichment (v1.4.8).

Fetches details ONLY for a capped set of selected top evidence POIs (never
every raw result). Enrichment data (rating / userRatingCount / priceLevel /
address / opening hours) is EVIDENCE ONLY — it never enters MCDA scoring.

Photos and AI summaries are appended to the field mask only behind their
config flags (both default OFF); they are UI/narrative-only by contract.
"""
from __future__ import annotations

import logging

import httpx

from ..config import get_settings
from .base import ProviderContext, ProviderResult, run_provider

logger = logging.getLogger(__name__)

DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"

# Minimal explicit field mask (Phase 5) — no `places.` prefix on Details.
DETAILS_FIELD_MASK_BASE = ",".join([
    "id",
    "displayName",
    "location",
    "formattedAddress",
    "primaryType",
    "types",
    "rating",
    "userRatingCount",
    "priceLevel",
    "priceRange",
    "regularOpeningHours",
    "websiteUri",
])
PHOTOS_FIELDS = "photos"
AI_SUMMARY_FIELDS = "generativeSummary,reviewSummary"


def details_field_mask() -> str:
    """Field mask assembled from config flags — photos / AI summaries are
    requested only when their flags are on (never in scoring either way)."""
    s = get_settings()
    mask = DETAILS_FIELD_MASK_BASE
    if s.enable_google_place_photos:
        mask += "," + PHOTOS_FIELDS
    if s.enable_google_ai_summaries:
        mask += "," + AI_SUMMARY_FIELDS
    return mask


def _headers() -> dict:
    return {
        "X-Goog-Api-Key": get_settings().google_places_api_key,
        "X-Goog-FieldMask": details_field_mask(),
    }


async def fetch_place_details(
    place_id: str,
    *,
    ctx: ProviderContext | None = None,
) -> ProviderResult:
    """Details for ONE place id. data = {"place": {…}} (minimal fields)."""
    s = get_settings()

    async def call() -> dict:
        async with httpx.AsyncClient(timeout=s.google_places_timeout_seconds) as client:
            r = await client.get(DETAILS_URL.format(place_id=place_id), headers=_headers())
            r.raise_for_status()
            raw = r.json()
        return {"place": {
            "placeId": raw.get("id"),
            "name": (raw.get("displayName") or {}).get("text", ""),
            "address": raw.get("formattedAddress"),
            "primaryType": raw.get("primaryType"),
            "rating": raw.get("rating"),
            "userRatingCount": raw.get("userRatingCount"),
            "priceLevel": raw.get("priceLevel"),
            "websiteUri": raw.get("websiteUri"),
        }}

    return await run_provider(
        call, provider="gdetails", feature="place_details",
        timeout=s.google_places_timeout_seconds + 2,
        max_retries=s.google_places_max_retries, ctx=ctx,
        cache_key=f"details|{place_id}",
    )


async def enrich_top_pois(
    pois: list[dict],
    *,
    cap: int,
    ctx: ProviderContext | None = None,
) -> list[dict]:
    """Enrich up to `cap` POIs that carry a placeId. Returns evidence dicts
    (subset of Details fields). Failures are skipped silently — enrichment is
    optional evidence, never load-bearing. Never raises."""
    out: list[dict] = []
    for p in pois:
        if len(out) >= cap:
            break
        pid = p.get("placeId")
        if not pid:
            continue
        try:
            pr = await fetch_place_details(pid, ctx=ctx)
        except Exception:   # defense-in-depth; run_provider shouldn't raise
            continue
        if pr.status == "ok" and pr.data.get("place"):
            out.append(pr.data["place"])
        elif pr.status in ("disabled", "degraded"):
            break           # API unavailable / budget out — stop trying
    return out
