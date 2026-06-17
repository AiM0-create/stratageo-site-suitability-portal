"""Consumer-POI source merging (v1.0.2).

OSM and Google Places only OVERLAP on consumer/commercial point POIs (cafés,
shops, clinics, gyms, hotels, banks, schools). For those layers we source from
BOTH and merge with spatial dedup, so a sparse result in one provider is backed
by the other — this kills the "competitor saturation: no data" class of failure
regardless of which source the consultant picked.

Infra/land/water/transit layers have no overlap (only OSM carries them), so they
stay single-source — they never hit these mappings.
"""
from __future__ import annotations

from .scoring import haversine_m

# Google Places type → equivalent OSM tag(s). Used to add a (near-free, batched)
# OSM supplement to a Places layer.
PLACES_TO_OSM: dict[str, list[str]] = {
    "cafe": ["amenity=cafe"],
    "restaurant": ["amenity=restaurant"],
    "bar": ["amenity=bar", "amenity=pub"],
    "night_club": ["amenity=nightclub"],
    "bakery": ["shop=bakery"],
    "meal_takeaway": ["amenity=fast_food"],
    "meal_delivery": ["amenity=fast_food"],
    "supermarket": ["shop=supermarket"],
    "grocery_or_supermarket": ["shop=supermarket", "shop=convenience"],
    "convenience_store": ["shop=convenience"],
    "shopping_mall": ["shop=mall"],
    "clothing_store": ["shop=clothes"],
    "electronics_store": ["shop=electronics"],
    "furniture_store": ["shop=furniture"],
    "gym": ["leisure=fitness_centre", "leisure=sports_centre"],
    "hospital": ["amenity=hospital"],
    "doctor": ["amenity=doctors", "amenity=clinic"],
    "pharmacy": ["amenity=pharmacy", "shop=chemist"],
    "school": ["amenity=school"],
    "primary_school": ["amenity=school"],
    "secondary_school": ["amenity=school"],
    "university": ["amenity=university"],
    "bank": ["amenity=bank"],
    "atm": ["amenity=atm"],
    "lodging": ["tourism=hotel"],
    "gas_station": ["amenity=fuel"],
    "car_repair": ["shop=car_repair"],
    "beauty_salon": ["shop=beauty", "shop=hairdresser"],
    "hair_care": ["shop=hairdresser"],
}

# Reverse: a consumer OSM tag → a representative Places type, so an OSM-typed
# consumer layer can be supplemented with Places. Broad/ambiguous tags (shop=*)
# are intentionally absent → no Places fetch for them.
OSM_TO_PLACES: dict[str, str] = {
    "amenity=cafe": "cafe",
    "amenity=restaurant": "restaurant",
    "amenity=fast_food": "meal_takeaway",
    "amenity=bar": "bar",
    "amenity=pub": "bar",
    "amenity=nightclub": "night_club",
    "shop=bakery": "bakery",
    "shop=supermarket": "supermarket",
    "shop=convenience": "convenience_store",
    "shop=mall": "shopping_mall",
    "shop=clothes": "clothing_store",
    "shop=electronics": "electronics_store",
    "leisure=fitness_centre": "gym",
    "leisure=sports_centre": "gym",
    "amenity=hospital": "hospital",
    "amenity=clinic": "doctor",
    "amenity=doctors": "doctor",
    "amenity=pharmacy": "pharmacy",
    "amenity=school": "school",
    "amenity=university": "university",
    "amenity=bank": "bank",
    "tourism=hotel": "lodging",
    "amenity=fuel": "gas_station",
}


def osm_tags_for_places(types: list[str]) -> list[str]:
    """OSM tag(s) that mirror a Places layer's types (empty if none are consumer)."""
    out: list[str] = []
    for t in types or []:
        out.extend(PLACES_TO_OSM.get(t, []))
    return sorted(set(out))


def places_type_for_osm(tags: list[str]) -> str | None:
    """A representative Places type for a consumer OSM layer, else None."""
    for t in tags or []:
        if t in OSM_TO_PLACES:
            return OSM_TO_PLACES[t]
    return None


def merge_pois(primary: list[dict], supplement: list[dict], dedup_m: float = 40.0) -> list[dict]:
    """Union of two POI sets, dropping supplement points within `dedup_m` of a
    primary point (same physical place mapped by both providers). `primary` is
    kept whole; only non-duplicate supplement points are appended."""
    if not supplement:
        return list(primary)
    if not primary:
        return list(supplement)
    out = list(primary)
    for s in supplement:
        if not any(
            haversine_m(s["lat"], s["lng"], p["lat"], p["lng"]) <= dedup_m
            for p in primary
        ):
            out.append(s)
    return out
