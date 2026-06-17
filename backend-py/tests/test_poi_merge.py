"""Unit tests for consumer-POI source merging (OSM + Google Places)."""
from app.engine import poi_merge


def test_places_to_osm_mapping():
    assert poi_merge.osm_tags_for_places(["cafe"]) == ["amenity=cafe"]
    assert poi_merge.osm_tags_for_places(["restaurant", "bar"]) == sorted(
        {"amenity=restaurant", "amenity=bar", "amenity=pub"}
    )
    # non-consumer / unknown types → no OSM supplement
    assert poi_merge.osm_tags_for_places(["airport"]) == []
    assert poi_merge.osm_tags_for_places([]) == []


def test_osm_to_places_mapping():
    assert poi_merge.places_type_for_osm(["amenity=cafe"]) == "cafe"
    assert poi_merge.places_type_for_osm(["leisure=fitness_centre"]) == "gym"
    # infra/land/broad tags → no Places back-up
    assert poi_merge.places_type_for_osm(["highway=motorway"]) is None
    assert poi_merge.places_type_for_osm(["landuse=residential"]) is None
    assert poi_merge.places_type_for_osm(["shop=*"]) is None


def test_merge_dedupes_colocated_points():
    # same café in both providers (~5 m apart) → counted once
    places = [{"lat": 22.5141, "lng": 88.4026}]
    osm = [{"lat": 22.51414, "lng": 88.40262}]  # ~5 m away
    merged = poi_merge.merge_pois(places, osm)
    assert len(merged) == 1


def test_merge_keeps_distinct_points():
    places = [{"lat": 22.5141, "lng": 88.4026}]
    osm = [{"lat": 22.5200, "lng": 88.4100}]   # ~1 km away
    merged = poi_merge.merge_pois(places, osm)
    assert len(merged) == 2


def test_merge_handles_empty_sides():
    pts = [{"lat": 1.0, "lng": 1.0}]
    assert poi_merge.merge_pois(pts, []) == pts
    assert poi_merge.merge_pois([], pts) == pts
    assert poi_merge.merge_pois([], []) == []
